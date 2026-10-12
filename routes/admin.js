const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');

function isSuperAdmin(req) {
  const u = req.user;
  return u && (u.SuperAdminStatus === 'True' || u.SuperAdminStatus === true || u.SuperAdminStatus === 'true');
}

function requireSA(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).json({ success: false, message: 'SuperAdmin access required' });
  next();
}

function getIST() {
  const d = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2,'0')}/${months[d.getMonth()]}/${d.getFullYear()}`;
}

// GET /api/admin/dashboard
router.get('/dashboard', requireAuth, requireSA, async (req, res) => {
  try {
    const d = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmt = dt => `${String(dt.getDate()).padStart(2,'0')}/${months[dt.getMonth()]}/${dt.getFullYear()}`;
    const data = await executeStoredProcedure('AdminDashboard', { FromDate: fmt(first), ToDate: fmt(d) });
    res.json({ success: true, data: data?.[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/stats
router.get('/stats', requireAuth, requireSA, async (req, res) => {
  try {
    const [users, activeUsers, totalGames, todayChats] = await Promise.all([
      executeQuery(`SELECT COUNT(*) AS cnt FROM Users`),
      executeQuery(`SELECT COUNT(*) AS cnt FROM Users WHERE IsActive='True'`),
      executeQuery(`SELECT COUNT(*) AS cnt FROM Game WHERE IsActive='True'`),
      executeQuery(`SELECT COUNT(*) AS cnt FROM Chat WHERE CAST(MessageDateTime AS date)=CAST(GETDATE() AS date)`)
    ]);
    res.json({ success: true, data: { totalUsers: users?.[0]?.cnt||0, activeUsers: activeUsers?.[0]?.cnt||0, totalGames: totalGames?.[0]?.cnt||0, todayChats: todayChats?.[0]?.cnt||0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/users
router.get('/users', requireAuth, requireSA, async (req, res) => {
  try {
    const data = await executeQuery(`SELECT UID, Mobile, IsSuperAdmin, Status AS IsActive, Validity AS ValidityDate, RegisteredOn FROM Users ORDER BY RegisteredOn DESC`);
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/users
router.post('/users', requireAuth, requireSA, async (req, res) => {
  try {
    const { mobile, password, validityDate, isSuperAdmin: isSA } = req.body;
    if (!mobile || !password) return res.status(400).json({ success: false, message: 'Mobile and password required' });
    await executeStoredProcedure('UserSignUP', { Mobile: mobile, Password: password, ValidityDate: validityDate || null, IsSuperAdmin: isSA || false });
    res.json({ success: true, message: 'User created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/users/:uid
router.put('/users/:uid', requireAuth, requireSA, async (req, res) => {
  try {
    const { mobile, isActive, validityDate, isSuperAdmin: isSA } = req.body;
    await executeQuery(
      `UPDATE Users SET Mobile=@mobile, Status=@isActive, Validity=@validityDate, IsSuperAdmin=@isSA WHERE UID=@uid`,
      { uid: parseInt(req.params.uid), mobile, isActive: isActive ? 'True' : 'False', validityDate: validityDate || null, isSA: isSA ? 'True' : 'False' }
    );
    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/subusers
router.get('/subusers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeQuery(
      `SELECT SubUserID, subusername, Mobile, Password, IsActive FROM subusers WHERE fcreatedUID=@uid`,
      { uid }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/subusers
router.post('/subusers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { name, mobile, password, isActive } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!mobile || !String(mobile).trim()) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }
    await executeStoredProcedure('AddSubusers', {
      Name: String(name).trim(), Mobile: String(mobile).trim(), password: password || '', IsActive: isActive !== false, createdid: uid
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/subusers/:id
router.put('/subusers/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { name, mobile, password, isActive } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!mobile || !String(mobile).trim()) {
      return res.status(400).json({ success: false, message: 'Mobile number is required' });
    }
    await executeStoredProcedure('UpdateSubusers', {
      subid: req.params.id, Name: String(name).trim(), Mobile: String(mobile).trim(), password: password || '', IsActive: isActive !== false, createdid: uid
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/access-rights?subUID=X
router.get('/access-rights', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { subUID } = req.query;
    let data;
    if (subUID) {
      data = await executeQuery(`SELECT * FROM AccessRight WHERE ARfSatffID=@subUID`, { subUID });
    } else {
      data = await executeStoredProcedure('ShowAllAccessRight', { fUID: uid });
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/access-rights/:id
router.get('/access-rights/:id', requireAuth, async (req, res) => {
  try {
    const subUID = req.params.id;
    const data = await executeQuery(`SELECT * FROM AccessRight WHERE ARfSatffID=@subUID`, { subUID });
    res.json({ success: true, data: data && data[0] ? data[0] : null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/access-rights
router.post('/access-rights', requireAuth, async (req, res) => {
  try {
    const { subUserID, addContacts, addGames, result, findChat, hisab, hisabSummary,
            dateWiseHisab, accounts, showAllAccounts, subUsers, balance, lc, plYantri, yantri, absentReport, changePassword } = req.body;
    const uid = req.user.UID;

    const existing = await executeQuery(
      `SELECT COUNT(*) AS cnt FROM AccessRight WHERE ARfSatffID=@subUserID AND fUID=@uid`,
      { subUserID, uid }
    );
    const count = existing?.[0]?.cnt || 0;

    if (count === 0) {
      await executeQuery(
        `INSERT INTO AccessRight
         (fUID, ARfSatffID, ADDContacts, ADDGames, Result, FindChat, Hisab, HisabSummary, DateWiseHisab, Accounts, ShowAllAccounts, SubUsers, Balance, LC, PLYantri, Yantri, AbsentReport, ChangePassword)
         VALUES
         (@uid, @subUserID, @addContacts, @addGames, @result, @findChat, @hisab, @hisabSummary, @dateWiseHisab, @accounts, @showAllAccounts, @subUsers, @balance, @lc, @plYantri, @yantri, @absentReport, @changePassword)`,
        {
          uid, subUserID,
          addContacts: !!addContacts, addGames: !!addGames, result: !!result, findChat: !!findChat,
          hisab: !!hisab, hisabSummary: !!hisabSummary, dateWiseHisab: !!dateWiseHisab,
          accounts: !!accounts, showAllAccounts: !!showAllAccounts, subUsers: !!subUsers,
          balance: !!balance, lc: !!lc, plYantri: !!plYantri, yantri: !!yantri,
          absentReport: !!absentReport, changePassword: !!changePassword
        }
      );
    } else {
      await executeQuery(
        `UPDATE AccessRight SET
         ADDContacts=@addContacts, ADDGames=@addGames, Result=@result, FindChat=@findChat,
         Hisab=@hisab, HisabSummary=@hisabSummary, DateWiseHisab=@dateWiseHisab,
         Accounts=@accounts, ShowAllAccounts=@showAllAccounts, SubUsers=@subUsers,
         Balance=@balance, LC=@lc, PLYantri=@plYantri, Yantri=@yantri,
         AbsentReport=@absentReport, ChangePassword=@changePassword
         WHERE ARfSatffID=@subUserID AND fUID=@uid`,
        {
          uid, subUserID,
          addContacts: !!addContacts, addGames: !!addGames, result: !!result, findChat: !!findChat,
          hisab: !!hisab, hisabSummary: !!hisabSummary, dateWiseHisab: !!dateWiseHisab,
          accounts: !!accounts, showAllAccounts: !!showAllAccounts, subUsers: !!subUsers,
          balance: !!balance, lc: !!lc, plYantri: !!plYantri, yantri: !!yantri,
          absentReport: !!absentReport, changePassword: !!changePassword
        }
      );
    }
    res.json({ success: true, message: 'Access rights saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/assigned-clients?staffID=X
router.get('/assigned-clients', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { staffID } = req.query;
    const data = await executeStoredProcedure('SelectClientForAssign', { fSenderID: uid, fStaffID: staffID || 0 });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/assign-clients
router.post('/assign-clients', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { staffID, customerIDs } = req.body;
    if (!staffID) return res.status(400).json({ success: false, message: 'staffID required' });
    await executeQuery(`DELETE FROM AssignClientToStaff WHERE fUID=@uid AND fStaffID=@staffID`, { uid, staffID });
    if (customerIDs && customerIDs.length > 0) {
      for (const cid of customerIDs) {
        if (!cid || cid === '') continue;
        await executeStoredProcedure('AssignClienttoSatff', { fStaffID: staffID, fCustID: cid.trim(), fUID: uid });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/change-password
router.post('/change-password', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid, newPassword } = req.body;
    if (!uid || !newPassword) return res.status(400).json({ success: false, message: 'UID and password required' });
    await executeQuery(`UPDATE Users SET Password=@newPassword WHERE UID=@uid`, { uid: parseInt(uid), newPassword });
    res.json({ success: true, message: 'Password changed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/user-sales-list?date=X
router.get('/user-sales-list', requireAuth, requireSA, async (req, res) => {
  try {
    const { date } = req.query;
    const data = await executeStoredProcedure('SelectTodaysSaleofUsers', {
      Todate: date || getIST()
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/user-sales-gamewise?date=X&uid=Y
router.get('/user-sales-gamewise', requireAuth, requireSA, async (req, res) => {
  try {
    const { date, uid } = req.query;
    const data = await executeStoredProcedure('SelectTodaysSaleofUsers', {
      Todate: date, UID: uid, OpType: 1
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/all-user-games?uid=X
router.get('/all-user-games', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid } = req.query;
    const data = await executeStoredProcedure('GetAllGames', { UID: uid });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/open-yantri?uid=X&gameID=Y&date=Z
router.get('/open-yantri', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid, gameID, date } = req.query;
    if (!uid || !gameID) return res.json({ success: true, data: [] });
    const data = await executeStoredProcedure('SelectTodaysSaleofUsers', {
      Todate: date || getIST(), UID: uid, GID: gameID, OpType: 2
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/block-user
router.post('/block-user', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid } = req.body;
    await executeQuery(`UPDATE Users SET IsActive='False' WHERE UID=@uid`, { uid: parseInt(uid) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/unblock-user
router.post('/unblock-user', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid, validityDate } = req.body;
    await executeQuery(
      `UPDATE Users SET IsActive='True', ValidityDate=@validityDate WHERE UID=@uid`,
      { uid: parseInt(uid), validityDate: validityDate || null }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/block-all
router.post('/block-all', requireAuth, requireSA, async (req, res) => {
  try {
    await executeQuery(`UPDATE Users SET IsActive='False'`, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/unblock-all
router.post('/unblock-all', requireAuth, requireSA, async (req, res) => {
  try {
    const { validityDate } = req.body;
    await executeQuery(`UPDATE Users SET IsActive='True', ValidityDate=@validityDate`, { validityDate: validityDate || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/back-to-admin (JWT-based: no real session switch possible, return info)
router.get('/back-to-admin', requireAuth, (req, res) => {
  res.json({ success: true });
});

// GET /api/admin/switch-user/:uid (JWT-based: generate new token for that uid)
router.get('/switch-user/:uid', requireAuth, requireSA, async (req, res) => {
  try {
    res.json({ success: true, message: 'Switch not supported in JWT mode — use admin credentials' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

// GET /api/admin/subscriptions — All Razorpay transactions & subscriber status
router.get('/subscriptions', requireAuth, requireSA, async (req, res) => {
  try {
    const data = await executeQuery(
      `SELECT sp.PaymentID, sp.UID, sp.Mobile, sp.PlanName, sp.PlanDays, sp.Amount, sp.Currency,
              sp.RazorpayOrderId, sp.RazorpayPaymentId, sp.PaymentStatus, sp.PreviousValidity, sp.NewValidity, sp.CreatedAt,
              u.Validity AS CurrentValidity, u.Status AS UserStatus
       FROM SubscriptionPayments sp
       LEFT JOIN Users u ON sp.UID = u.UID
       ORDER BY sp.PaymentID DESC`
    );
    const summary = await executeQuery(
      `SELECT 
         COUNT(*) AS TotalOrders,
         SUM(CASE WHEN PaymentStatus='SUCCESS' THEN 1 ELSE 0 END) AS SuccessfulOrders,
         SUM(CASE WHEN PaymentStatus='SUCCESS' THEN Amount ELSE 0 END) AS TotalRevenue
       FROM SubscriptionPayments`
    );
    res.json({ success: true, data: data || [], summary: summary?.[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/extend-subscription — Manual extension by SuperAdmin
router.post('/extend-subscription', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid, days, newValidityDate } = req.body;
    if (!uid) return res.status(400).json({ success: false, message: 'UID required' });

    let finalDateStr = '';
    if (newValidityDate) {
      finalDateStr = newValidityDate;
    } else if (days) {
      const uRows = await executeQuery(`SELECT Validity FROM Users WHERE UID=@uid`, { uid: parseInt(uid) });
      const cur = uRows?.[0]?.Validity ? new Date(uRows[0].Validity) : null;
      const today = new Date(); today.setHours(0,0,0,0);
      let base = (cur && cur.getTime() >= today.getTime()) ? cur : today;
      const target = new Date(base.getTime() + parseInt(days) * 24 * 60 * 60 * 1000);
      finalDateStr = target.toISOString().split('T')[0];
    } else {
      return res.status(400).json({ success: false, message: 'Days or newValidityDate required' });
    }

    await executeQuery(
      `UPDATE Users SET Validity=@val, Status='True' WHERE UID=@uid`,
      { val: finalDateStr, uid: parseInt(uid) }
    );

    // Record manual grant in history
    const uRows = await executeQuery(`SELECT Mobile FROM Users WHERE UID=@uid`, { uid: parseInt(uid) });
    const mobile = uRows?.[0]?.Mobile || '';
    await executeQuery(
      `INSERT INTO SubscriptionPayments (UID, Mobile, PlanName, PlanDays, Amount, RazorpayOrderId, PaymentStatus, NewValidity)
       VALUES (@uid, @mobile, 'Manual Admin Grant', @days, 0, 'MANUAL_GRANT', 'SUCCESS', @val)`,
      { uid: parseInt(uid), mobile, days: days || 0, val: finalDateStr }
    );

    res.json({ success: true, message: 'Subscription successfully extended!', validity: finalDateStr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
