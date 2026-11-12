const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { getSubscription, denialFor } = require('../utils/subscription');

const JWT_SECRET = process.env.JWT_SECRET || 'susu9_mobile_jwt_secret_2024_xK9mP';

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

const isBitTrue = v => v === true || v === 'True' || v === 1 || String(v) === '1' || String(v).toLowerCase() === 'true';

async function bindAccessRight(staffID) {
  if (!staffID) return getDefaultAccess();
  try {
    const data = await executeQuery(
      `SELECT * FROM AccessRight WHERE ARfSatffID = @staffID`,
      { staffID }
    );
    if (data && data.length >= 1) {
      const ar = data[0];
      return {
        ADDContacts: isBitTrue(ar.ADDContacts),
        ADDGames: isBitTrue(ar.ADDGames),
        Result: isBitTrue(ar.Result),
        FindChat: isBitTrue(ar.FindChat),
        Hisab: isBitTrue(ar.Hisab),
        HisabSummary: isBitTrue(ar.HisabSummary),
        DateWiseHisab: isBitTrue(ar.DateWiseHisab),
        Accounts: isBitTrue(ar.Accounts),
        ShowAllAccounts: isBitTrue(ar.ShowAllAccounts),
        SubUsers: isBitTrue(ar.SubUsers),
        Balance: isBitTrue(ar.Balance),
        LC: isBitTrue(ar.LC),
        PLYantri: isBitTrue(ar.PLYantri),
        Yantri: isBitTrue(ar.Yantri),
        AbsentReport: isBitTrue(ar.AbsentReport),
        ChangePassword: isBitTrue(ar.ChangePassword)
      };
    }
    return getDefaultAccess();
  } catch (e) { return getDefaultAccess(); }
}

function getDefaultAccess() {
  return {
    ADDContacts: false, ADDGames: false, Result: false, FindChat: false,
    Hisab: false, HisabSummary: false, DateWiseHisab: false,
    Accounts: false, ShowAllAccounts: false, SubUsers: false, Balance: false,
    LC: false, PLYantri: false, Yantri: false, AbsentReport: false, ChangePassword: false
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password) {
      return res.status(400).json({ success: false, message: 'Mobile aur password required hai' });
    }

    let users = [];
    try {
      users = await executeStoredProcedure('Login', { Mobile: mobile, Password: password });
    } catch (e) {
      users = await executeQuery(
        `SELECT UID, Mobile, Password, IsSuperAdmin FROM Users WHERE Mobile = @mobile AND Password = @password AND IsActive = 'True'`,
        { mobile, password }
      );
    }

    if (!users || users.length === 0) {
      // The Login SP also rejects expired/blocked accounts. If the
      // credentials are right, tell a subscribed Admin *why* instead of
      // "wrong password".
      try {
        const match = await executeQuery(
          `SELECT TOP 1 UID FROM Users WHERE Mobile = @mobile AND Password = @password`,
          { mobile, password }
        );
        if (match && match[0]) {
          const denial = denialFor(await getSubscription(match[0].UID, { fresh: true }));
          if (denial) return res.status(403).json({ success: false, ...denial, mobile });
        }
      } catch (e) {}
      return res.status(401).json({ success: false, message: 'Mobile ya password galat hai' });
    }

    const user = users[0];
    const subscription = await getSubscription(user.UID, { fresh: true });
    const denial = denialFor(subscription);
    if (denial) return res.status(403).json({ success: false, ...denial, mobile });
    let isRefreshStatus = 'False';
    try {
      const rf = await executeQuery(`SELECT IsRefreshStatus FROM Users WHERE UID=@uid`, { uid: user.UID });
      if (rf && rf[0]) isRefreshStatus = rf[0].IsRefreshStatus?.toString() || 'False';
    } catch (e) {}

    const payload = {
      UID: user.UID,
      Mobile: mobile,
      SuperAdmin: 'SuperAdmin',
      SuperAdminStatus: user.IsSuperAdmin ? user.IsSuperAdmin.toString() : 'False',
      IsRefreshStatus: isRefreshStatus,
      SubUID: null
    };

    const token = generateToken(payload);
    res.json({ success: true, token, user: { ...payload, Subscription: subscription } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// POST /api/auth/subuser-login
router.post('/subuser-login', async (req, res) => {
  try {
    const { subUserID, password } = req.body;
    if (!subUserID || !password) {
      return res.status(400).json({ success: false, message: 'SubUser ID aur password required hai' });
    }

    const subUsers = await executeQuery(
      `SELECT * FROM subusers WHERE SubUserID = @subUserID AND Password = @password AND IsActive = 'True'`,
      { subUserID, password }
    );

    if (!subUsers || subUsers.length !== 1) {
      return res.status(401).json({ success: false, message: 'Invalid credentials ya account inactive hai' });
    }

    const subUser = subUsers[0];
    const parentUID = subUser.fcreatedUID;
    const parentDenial = denialFor(await getSubscription(parentUID, { fresh: true }));
    if (parentDenial) {
      return res.status(403).json({
        success: false,
        code: parentDenial.code,
        message: parentDenial.code === 'ACCOUNT_BLOCKED'
          ? 'Aapke Admin ka account block hai. Admin se contact karein.'
          : 'Aapke Admin ka subscription expire ho gaya hai. Admin se renew karwayein.',
      });
    }
    const access = await bindAccessRight(subUserID);

    let parentMobile = '';
    try {
      const parentRows = await executeQuery(`SELECT Mobile FROM Users WHERE UID = @uid`, { uid: parentUID });
      if (parentRows && parentRows[0]) parentMobile = parentRows[0].Mobile;
    } catch (e) {}

    const payload = {
      UID: parentUID,
      Mobile: parentMobile || subUser.Mobile || '',
      StaffMobile: subUser.Mobile || '',
      SuperAdmin: '',
      SuperAdminStatus: 'False',
      SubUID: subUserID,
      ...access
    };

    const token = generateToken(payload);
    res.json({ success: true, token, user: payload });
  } catch (err) {
    console.error('SubUser login error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { iat, exp, ...user } = req.user;
    if (user.SubUID) {
      const access = await bindAccessRight(user.SubUID);
      Object.assign(user, access);
    }
    user.Subscription = req.subscription || null;
    res.json({ success: true, user });
  } catch (e) {
    res.json({ success: true, user: req.user });
  }
});

// GET /api/auth/subscription — the signed-in Admin's plan + history.
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subscription = await getSubscription(uid, { fresh: true });
    let history = [];
    let usage = null;
    if (subscription) {
      history = await executeQuery(
        `SELECT HistoryID, PlanName, Amount, DurationDays, StartDate, EndDate, Action, CreatedOn
         FROM SubscriptionHistory WHERE fUID = @uid ORDER BY HistoryID DESC`,
        { uid }
      );
      const counts = await executeQuery(
        `SELECT (SELECT COUNT(*) FROM subusers WHERE fcreatedUID = @uid) AS SubUsers,
                (SELECT COUNT(*) FROM Customers WHERE fUID = @uid) AS Customers`,
        { uid }
      );
      usage = counts?.[0] || null;
    }
    res.json({ success: true, data: { subscription, usage, history: history || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/today
router.get('/today', (req, res) => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  res.json({ success: true, date: ist.toISOString(), serverDate: ist.toDateString() });
});

// POST /api/auth/refresh
router.post('/refresh', requireAuth, (req, res) => {
  const { iat, exp, ...payload } = req.user;
  const token = generateToken(payload);
  res.json({ success: true, token });
});

// POST /api/auth/reset-password — login screen's "Change Password" (User),
// no login required: verified by Mobile + current Password instead.
router.post('/reset-password', async (req, res) => {
  try {
    const { mobile, currentPassword, newPassword } = req.body;
    if (!mobile || !currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'Mobile, current password aur new password required hai' });

    const rows = await executeQuery(
      `SELECT UID FROM Users WHERE Mobile=@mobile AND Password=@pwd`,
      { mobile, pwd: currentPassword }
    );
    if (!rows || rows.length === 0)
      return res.status(400).json({ success: false, message: 'Mobile ya current password galat hai' });

    await executeQuery(
      `UPDATE Users SET Password=@newPwd WHERE UID=@uid`,
      { uid: rows[0].UID, newPwd: newPassword }
    );
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/reset-subuser-password — login screen's "Change Password"
// (Staff), verified by SubUser ID + current Password.
router.post('/reset-subuser-password', async (req, res) => {
  try {
    const { subUserID, currentPassword, newPassword } = req.body;
    if (!subUserID || !currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'SubUser ID, current password aur new password required hai' });

    const rows = await executeQuery(
      `SELECT SubUserID FROM subusers WHERE SubUserID=@id AND Password=@pwd`,
      { id: subUserID, pwd: currentPassword }
    );
    if (!rows || rows.length === 0)
      return res.status(400).json({ success: false, message: 'SubUser ID ya current password galat hai' });

    await executeQuery(
      `UPDATE subusers SET Password=@newPwd WHERE SubUserID=@id`,
      { id: subUserID, newPwd: newPassword }
    );
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/register — login screen's "New User" self-signup. Creates
// the account immediately active with no validity/expiry limit (same
// UserSignUP SP the SuperAdmin panel uses, just without that gate).
//
// With the subscription model, new Admins are created by a Super Manager after
// payment verification, so open signup is OFF unless ALLOW_SELF_REGISTER=true.
router.post('/register', async (req, res) => {
  if (String(process.env.ALLOW_SELF_REGISTER).toLowerCase() !== 'true') {
    return res.status(403).json({
      success: false,
      code: 'REGISTRATION_CLOSED',
      message: 'Naya account subscription lekar banta hai. Login page par "Get a Subscription" par click karein.',
    });
  }
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password)
      return res.status(400).json({ success: false, message: 'Mobile aur password required hai' });
    if (!/^\d{10}$/.test(mobile))
      return res.status(400).json({ success: false, message: 'Mobile number 10 digit ka hona chahiye' });
    if (String(password).length < 4)
      return res.status(400).json({ success: false, message: 'Password kam se kam 4 characters ka hona chahiye' });

    const existing = await executeQuery(`SELECT UID FROM Users WHERE Mobile=@mobile`, { mobile });
    if (existing && existing.length > 0)
      return res.status(409).json({ success: false, message: 'Is mobile number se account pehle se bana hua hai' });

    // Validity: '' (not null) so the SP's own "if empty, default to
    // 31/Dec/2050" branch fires — a real NULL stores as NULL, and Login's
    // `Validity >= getdate()` check silently excludes NULL rows.
    const result = await executeStoredProcedure('UserSignUP', { Mobile: mobile, Password: password, Validity: '' });
    const uid = result?.[0]?.UID || result?.[0]?.['']  || null;

    // UserSignUP always inserts Status='False' — Login's WHERE clause
    // requires Status='True', so without this the new account can never
    // log in. Flip it immediately since "turant active" was the chosen behavior.
    if (uid) {
      await executeQuery(`UPDATE Users SET Status='True' WHERE UID=@uid`, { uid });
    }

    res.json({ success: true, message: 'Account create ho gaya! Ab login karein.', uid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'Old and new password required' });

    const user = await executeQuery(
      `SELECT UID FROM Users WHERE UID=@uid AND Password=@oldPassword`,
      { uid, oldPassword }
    );
    if (!user || user.length === 0)
      return res.status(401).json({ success: false, message: 'Old password is incorrect' });

    await executeQuery(
      `UPDATE Users SET Password=@newPassword WHERE UID=@uid`,
      { uid, newPassword }
    );
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
