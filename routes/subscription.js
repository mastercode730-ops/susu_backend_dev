// Public (no login) endpoints used by the Subscribe page on web and mobile.
const express = require('express');
const router = express.Router();
const { executeQuery } = require('../config/database');
const { findUserByMobile, getSubscription } = require('../utils/subscription');
const { notifySuperManagers } = require('../utils/notify');

// Data URL of a png/jpeg/webp image. Size is checked separately.
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_SCREENSHOT_CHARS = 6 * 1024 * 1024; // ~4.5 MB binary

// Public endpoints: never leak DB/internal error text to anonymous visitors.
function serverError(res, err) {
  console.error('[subscription]', err);
  res.status(500).json({ success: false, message: 'Server error. Thodi der baad try karein.' });
}

function clean(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// GET /api/subscription/plans
router.get('/plans', async (req, res) => {
  try {
    const data = await executeQuery(
      `SELECT PlanID, PlanName, DurationDays, Price, MaxSubUsers, MaxCustomers, Description
       FROM SubscriptionPlans WHERE IsActive = 1 ORDER BY SortOrder, Price`
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    serverError(res, err);
  }
});

// GET /api/subscription/payment-info — QR + bank details set by the Super Manager.
router.get('/payment-info', async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT QrImage, UpiID, PayeeName, BankName, AccountHolder, AccountNumber, IFSC, BranchName, Instructions, SupportMobile, UpdatedOn
       FROM PaymentSettings WHERE SettingID = 1`
    );
    res.json({ success: true, data: rows?.[0] || {} });
  } catch (err) {
    serverError(res, err);
  }
});

// POST /api/subscription/request — submit payment proof.
// Body: { fullName, mobile, email?, planId, transactionRef?, notes?, screenshot (data URL) }
router.post('/request', async (req, res) => {
  try {
    const fullName = clean(req.body.fullName, 150);
    const mobile = String(req.body.mobile || '').replace(/\D/g, '');
    const email = clean(req.body.email, 150);
    const transactionRef = clean(req.body.transactionRef, 100);
    const notes = clean(req.body.notes, 500);
    const planId = parseInt(req.body.planId, 10);
    const screenshot = typeof req.body.screenshot === 'string' ? req.body.screenshot.trim() : '';

    if (!fullName) return res.status(400).json({ success: false, message: 'Naam required hai' });
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ success: false, message: 'Mobile number 10 digit ka hona chahiye' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Email sahi nahi hai' });
    if (!planId) return res.status(400).json({ success: false, message: 'Plan select karein' });
    if (!screenshot) return res.status(400).json({ success: false, message: 'Payment screenshot upload karein' });
    if (!IMAGE_DATA_URL.test(screenshot)) return res.status(400).json({ success: false, message: 'Screenshot PNG/JPG/WEBP image honi chahiye' });
    if (screenshot.length > MAX_SCREENSHOT_CHARS) return res.status(413).json({ success: false, message: 'Screenshot bahut badi hai (max ~4 MB)' });

    const plans = await executeQuery(
      `SELECT PlanID, PlanName, DurationDays, Price FROM SubscriptionPlans WHERE PlanID = @planId AND IsActive = 1`,
      { planId }
    );
    if (!plans || !plans.length) return res.status(400).json({ success: false, message: 'Selected plan available nahi hai' });
    const plan = plans[0];

    // Stop spam: at most 3 open requests per mobile.
    const open = await executeQuery(
      `SELECT COUNT(*) AS cnt FROM SubscriptionRequests WHERE Mobile = @mobile AND Status IN ('Pending', 'Processing')`,
      { mobile }
    );
    if ((open?.[0]?.cnt || 0) >= 3) {
      return res.status(429).json({ success: false, message: 'Is mobile se pehle hi requests pending hain. Verification ka intezaar karein.' });
    }

    // Existing subscribed admin → renewal; otherwise a new account.
    let requestType = 'NEW';
    const existing = await findUserByMobile(mobile);
    if (existing) {
      const sub = await getSubscription(existing.UID, { fresh: true });
      if (sub) requestType = 'RENEW';
    }

    const rows = await executeQuery(
      `INSERT INTO SubscriptionRequests
         (RequestType, FullName, Mobile, Email, fPlanID, PlanName, DurationDays, Amount, TransactionRef, Notes, Screenshot, Status, ClientIP)
       OUTPUT INSERTED.RequestID, INSERTED.CreatedOn
       VALUES (@requestType, @fullName, @mobile, @email, @planId, @planName, @days, @amount, @transactionRef, @notes, @screenshot, 'Pending', @ip)`,
      {
        requestType, fullName, mobile, email, planId,
        planName: plan.PlanName, days: plan.DurationDays, amount: Number(plan.Price),
        transactionRef, notes, screenshot, ip: clean(req.ip, 64),
      }
    );
    const requestId = rows?.[0]?.RequestID;

    notifySuperManagers(
      `💰 New ${requestType === 'RENEW' ? 'renewal' : 'subscription'} payment #${requestId}: ${fullName} (${mobile}) — ${plan.PlanName} ₹${plan.Price}. Verify in the Super Manager portal.`,
      { requestId, mobile, plan: plan.PlanName, amount: Number(plan.Price), type: requestType }
    );

    res.json({
      success: true,
      requestId,
      requestType,
      message: 'Payment details submit ho gaye. Verification ke baad aapko login details mil jayenge.',
    });
  } catch (err) {
    serverError(res, err);
  }
});

// GET /api/subscription/request-status?mobile=..&requestId=..
// Both are required so request details can't be enumerated by id alone.
router.get('/request-status', async (req, res) => {
  try {
    const mobile = String(req.query.mobile || '').replace(/\D/g, '');
    const requestId = parseInt(req.query.requestId, 10);
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ success: false, message: 'Mobile number 10 digit ka hona chahiye' });

    const params = { mobile };
    let where = 'Mobile = @mobile';
    if (requestId) { where += ' AND RequestID = @requestId'; params.requestId = requestId; }
    else return res.status(400).json({ success: false, message: 'Request ID required hai' });

    const rows = await executeQuery(
      `SELECT RequestID, RequestType, FullName, PlanName, Amount, Status, Remarks, CreatedOn, ReviewedOn
       FROM SubscriptionRequests WHERE ${where}`,
      params
    );
    if (!rows || !rows.length) return res.status(404).json({ success: false, message: 'Request nahi mili. Mobile aur Request ID check karein.' });
    const r = rows[0];
    // "Processing" is an internal lock state — show it as pending.
    if (r.Status === 'Processing') r.Status = 'Pending';
    res.json({ success: true, data: r });
  } catch (err) {
    serverError(res, err);
  }
});

module.exports = router;
