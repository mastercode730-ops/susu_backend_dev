const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { executeQuery } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Monthly Plan',
    days: 30,
    amount: 999,
    currency: 'INR',
    description: 'Full portal access for 30 days',
    savings: ''
  },
  quarterly: {
    id: 'quarterly',
    name: 'Quarterly Plan',
    days: 90,
    amount: 2499,
    currency: 'INR',
    description: 'Full portal access for 90 days',
    savings: 'Save ₹498 (17% OFF)'
  },
  yearly: {
    id: 'yearly',
    name: 'Yearly Plan',
    days: 365,
    amount: 7999,
    currency: 'INR',
    description: 'Full portal access for 365 days (Best Value)',
    savings: 'Save ₹3,989 (33% OFF)'
  }
};

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_Tl51I4CnTP3YPF';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'lq7Srjd3r0YhZhZm0kM7FPRe';
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function formatDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// GET /api/subscription/plans
router.get('/plans', (req, res) => {
  res.json({
    success: true,
    plans: Object.values(PLANS),
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_Tl51I4CnTP3YPF'
  });
});

// GET /api/subscription/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const userRows = await executeQuery(
      `SELECT UID, Mobile, Validity, RegisteredOn, Status, IsSuperAdmin FROM Users WHERE UID = @uid`,
      { uid }
    );
    if (!userRows || userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const u = userRows[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let validityDate = null;
    let daysRemaining = 0;
    let isExpired = false;

    if (u.Validity) {
      validityDate = new Date(u.Validity);
      validityDate.setHours(0, 0, 0, 0);
      const diffMs = validityDate.getTime() - today.getTime();
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      isExpired = daysRemaining < 0;
    } else {
      isExpired = true;
    }

    // Check payment history
    const history = await executeQuery(
      `SELECT TOP 20 PaymentID, PlanName, PlanDays, Amount, Currency, RazorpayPaymentId, PaymentStatus, PreviousValidity, NewValidity, CreatedAt
       FROM SubscriptionPayments WHERE UID = @uid ORDER BY PaymentID DESC`,
      { uid }
    );

    const hasPaid = (history || []).some(h => h.PaymentStatus === 'SUCCESS');
    const isTrial = !hasPaid && !isExpired;

    let trialDays = 12;
    try {
      const conf = await executeQuery("SELECT ConfigValue FROM SystemConfig WHERE ConfigKey='FREE_TRIAL_DAYS'");
      if (conf && conf[0] && !isNaN(parseInt(conf[0].ConfigValue))) {
        trialDays = parseInt(conf[0].ConfigValue);
      }
    } catch(e) {}

    res.json({
      success: true,
      data: {
        uid: u.UID,
        mobile: u.Mobile,
        validity: formatDate(u.Validity),
        registeredOn: formatDate(u.RegisteredOn),
        daysRemaining: Math.max(0, daysRemaining),
        isExpired,
        isTrial,
        trialDays,
        planType: isTrial ? `Free Trial (${trialDays} Days)` : (hasPaid ? 'Paid Subscription' : 'Expired Plan'),
        history: history || []
      }
    });
  } catch (err) {
    console.error('Subscription status error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/subscription/create-order
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { planId } = req.body;
    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Invalid subscription plan selected' });
    }

    const rzp = getRazorpayInstance();
    const amountInPaise = Math.round(plan.amount * 100);
    const receipt = `sub_${uid}_${Date.now()}`.slice(0, 40);

    const order = await rzp.orders.create({
      amount: amountInPaise,
      currency: plan.currency,
      receipt,
      notes: {
        uid: String(uid),
        mobile: String(req.user.Mobile || ''),
        planId: plan.id,
        planDays: String(plan.days)
      }
    });

    const userRows = await executeQuery(`SELECT Mobile, Validity FROM Users WHERE UID = @uid`, { uid });
    const userMobile = userRows?.[0]?.Mobile || req.user.Mobile || '';
    const currentValidity = formatDate(userRows?.[0]?.Validity);

    await executeQuery(
      `INSERT INTO SubscriptionPayments (UID, Mobile, PlanName, PlanDays, Amount, Currency, RazorpayOrderId, PaymentStatus, PreviousValidity)
       VALUES (@uid, @mobile, @planName, @planDays, @amount, @currency, @orderId, 'CREATED', @prevVal)`,
      {
        uid,
        mobile: userMobile,
        planName: plan.name,
        planDays: plan.days,
        amount: plan.amount,
        currency: plan.currency,
        orderId: order.id,
        prevVal: currentValidity
      }
    );

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_Tl51I4CnTP3YPF',
      plan
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ success: false, message: 'Error creating Razorpay order: ' + err.message });
  }
});

// POST /api/subscription/verify-payment
router.post('/verify-payment', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment verification parameters missing' });
    }

    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ success: false, message: 'Invalid plan' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'lq7Srjd3r0YhZhZm0kM7FPRe';
    const bodyToSign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(bodyToSign)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      await executeQuery(
        `UPDATE SubscriptionPayments SET PaymentStatus = 'FAILED', RazorpayPaymentId = @pid, RazorpaySignature = @sig, UpdatedAt = GETDATE()
         WHERE RazorpayOrderId = @oid AND UID = @uid`,
        { pid: razorpay_payment_id, sig: razorpay_signature, oid: razorpay_order_id, uid }
      );
      return res.status(400).json({ success: false, message: 'Payment signature verification failed' });
    }

    // Fetch user current validity
    const userRows = await executeQuery(`SELECT Validity FROM Users WHERE UID = @uid`, { uid });
    const currentVal = userRows?.[0]?.Validity ? new Date(userRows[0].Validity) : null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let baseDate = today;
    if (currentVal && currentVal.getTime() >= today.getTime()) {
      baseDate = new Date(currentVal.getTime());
    }

    const newValidityDate = new Date(baseDate.getTime() + plan.days * 24 * 60 * 60 * 1000);
    const newValidityStr = formatDate(newValidityDate);

    // Update Users table: Validity and Status = True
    await executeQuery(
      `UPDATE Users SET Validity = @newVal, Status = 'True' WHERE UID = @uid`,
      { newVal: newValidityStr, uid }
    );

    // Update SubscriptionPayments table
    await executeQuery(
      `UPDATE SubscriptionPayments
       SET PaymentStatus = 'SUCCESS', RazorpayPaymentId = @pid, RazorpaySignature = @sig, NewValidity = @newVal, UpdatedAt = GETDATE()
       WHERE RazorpayOrderId = @oid AND UID = @uid`,
      { pid: razorpay_payment_id, sig: razorpay_signature, newVal: newValidityStr, oid: razorpay_order_id, uid }
    );

    res.json({
      success: true,
      message: `${plan.name} successfully activated!`,
      validity: newValidityStr,
      daysAdded: plan.days
    });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/subscription/webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '1Ww4SOCQ77Bf-3fXNbgu0iWM5os7idts';
    const signature = req.headers['x-razorpay-signature'];
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    if (signature && signature !== expectedSignature) {
      return res.status(400).json({ status: 'invalid_signature' });
    }

    const event = typeof req.body === 'object' ? req.body : JSON.parse(payload);
    if (event.event === 'order.paid' || event.event === 'payment.captured') {
      const paymentEntity = event.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      if (orderId) {
        const orderRows = await executeQuery(
          `SELECT UID, PlanDays, PaymentStatus FROM SubscriptionPayments WHERE RazorpayOrderId = @oid`,
          { oid: orderId }
        );
        if (orderRows && orderRows[0] && orderRows[0].PaymentStatus !== 'SUCCESS') {
          const { UID, PlanDays } = orderRows[0];
          const userRows = await executeQuery(`SELECT Validity FROM Users WHERE UID = @uid`, { uid: UID });
          const currentVal = userRows?.[0]?.Validity ? new Date(userRows[0].Validity) : null;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          let baseDate = (currentVal && currentVal.getTime() >= today.getTime()) ? currentVal : today;
          const newValidityDate = new Date(baseDate.getTime() + PlanDays * 24 * 60 * 60 * 1000);
          const newValidityStr = formatDate(newValidityDate);

          await executeQuery(`UPDATE Users SET Validity = @newVal, Status = 'True' WHERE UID = @uid`, { newVal: newValidityStr, uid: UID });
          await executeQuery(
            `UPDATE SubscriptionPayments SET PaymentStatus = 'SUCCESS', RazorpayPaymentId = @pid, NewValidity = @newVal, UpdatedAt = GETDATE() WHERE RazorpayOrderId = @oid`,
            { pid: paymentEntity.id, newVal: newValidityStr, oid: orderId }
          );
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ status: 'error' });
  }
});

module.exports = router;
