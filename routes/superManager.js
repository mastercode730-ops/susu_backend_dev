// Super Manager API — top-level role that sells subscriptions, verifies
// payments, creates Admin logins and manages other Super Managers.
// Mounted at /api/sm.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { executeQuery } = require('../config/database');
const { requireSuperManager, invalidateSuperManager, JWT_SECRET, SM_ROLE } = require('../middleware/auth');
const sub = require('../utils/subscription');

const ok = (res, extra = {}) => res.json({ success: true, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const fail = (res, err) => {
  console.error('[sm]', err);
  res.status(500).json({ success: false, message: err.message });
};

const MOBILE = /^\d{10}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/;
const str = (v, max = 500) => (v === undefined || v === null ? null : (String(v).trim().slice(0, max) || null));
const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : null));

// ════════════════════════════════ Auth ════════════════════════════════

// POST /api/sm/login { mobile, password }
router.post('/login', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const password = String(req.body.password || '');
    if (!mobile || !password) return bad(res, 'Mobile aur password required hai');
    const rows = await executeQuery(`SELECT SMID, Name, Mobile, PasswordHash, IsActive FROM SuperManagers WHERE Mobile = @mobile`, { mobile });
    const sm = rows && rows[0];
    const valid = sm && (await bcrypt.compare(password, sm.PasswordHash));
    if (!valid) return bad(res, 'Mobile ya password galat hai', 401);
    if (!(sm.IsActive === true || sm.IsActive === 1)) return bad(res, 'Account inactive hai', 403);
    await executeQuery(`UPDATE SuperManagers SET LastLoginOn = GETDATE() WHERE SMID = @id`, { id: sm.SMID });
    const user = { role: SM_ROLE, SMID: sm.SMID, Name: sm.Name, Mobile: sm.Mobile };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: process.env.SM_JWT_EXPIRES_IN || '1d' });
    ok(res, { token, user });
  } catch (err) { fail(res, err); }
});

router.use(requireSuperManager);

// GET /api/sm/me
router.get('/me', (req, res) => ok(res, { user: { role: SM_ROLE, ...req.sm } }));

// POST /api/sm/change-password { oldPassword, newPassword }
router.post('/change-password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return bad(res, 'Old aur new password required hai');
    if (String(newPassword).length < 6) return bad(res, 'Password kam se kam 6 characters ka hona chahiye');
    const rows = await executeQuery(`SELECT PasswordHash FROM SuperManagers WHERE SMID = @id`, { id: req.sm.SMID });
    if (!rows.length || !(await bcrypt.compare(String(oldPassword), rows[0].PasswordHash))) return bad(res, 'Old password galat hai');
    const hash = await bcrypt.hash(String(newPassword), 10);
    await executeQuery(`UPDATE SuperManagers SET PasswordHash = @hash WHERE SMID = @id`, { hash, id: req.sm.SMID });
    ok(res, { message: 'Password changed' });
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════ Dashboard / alerts ═══════════════════════════

// GET /api/sm/summary
router.get('/summary', async (req, res) => {
  try {
    const rows = await executeQuery(`
      DECLARE @today DATE = CAST(GETDATE() AS DATE);
      SELECT
        (SELECT COUNT(*) FROM SubscriptionRequests WHERE Status IN ('Pending','Processing')) AS PendingRequests,
        (SELECT COUNT(*) FROM AdminAccounts) AS TotalAdmins,
        (SELECT COUNT(*) FROM AdminAccounts WHERE IsBlocked = 0 AND EndDate >= @today) AS ActiveAdmins,
        (SELECT COUNT(*) FROM AdminAccounts WHERE IsBlocked = 0 AND EndDate >= @today AND EndDate <= DATEADD(day, 7, @today)) AS ExpiringSoon,
        (SELECT COUNT(*) FROM AdminAccounts WHERE IsBlocked = 0 AND EndDate < @today) AS ExpiredAdmins,
        (SELECT COUNT(*) FROM AdminAccounts WHERE IsBlocked = 1) AS BlockedAdmins,
        (SELECT ISNULL(SUM(Amount), 0) FROM SubscriptionHistory
           WHERE Action IN ('CREATE','RENEW') AND CreatedOn >= DATEFROMPARTS(YEAR(@today), MONTH(@today), 1)) AS RevenueThisMonth,
        (SELECT ISNULL(SUM(Amount), 0) FROM SubscriptionHistory WHERE Action IN ('CREATE','RENEW')) AS RevenueTotal`);
    ok(res, { data: rows?.[0] || {} });
  } catch (err) { fail(res, err); }
});

// GET /api/sm/notifications — light endpoint the portal polls for new payments.
router.get('/notifications', async (req, res) => {
  try {
    const rows = await executeQuery(`
      SELECT TOP 10 RequestID, RequestType, FullName, Mobile, PlanName, Amount, CreatedOn
      FROM SubscriptionRequests WHERE Status IN ('Pending','Processing') ORDER BY RequestID DESC`);
    const count = await executeQuery(`SELECT COUNT(*) AS cnt FROM SubscriptionRequests WHERE Status IN ('Pending','Processing')`);
    ok(res, {
      pending: count?.[0]?.cnt || 0,
      latestId: rows && rows[0] ? rows[0].RequestID : 0,
      items: rows || [],
    });
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════ Payment requests ═══════════════════════════

// GET /api/sm/requests?status=Pending|Approved|Rejected|All&q=
router.get('/requests', async (req, res) => {
  try {
    const status = String(req.query.status || 'Pending');
    const q = str(req.query.q, 100);
    const params = {};
    const where = [];
    if (status === 'Pending') where.push(`r.Status IN ('Pending','Processing')`);
    else if (status !== 'All') { where.push('r.Status = @status'); params.status = status; }
    if (q) {
      where.push(`(r.Mobile LIKE @q OR r.FullName LIKE @q OR r.TransactionRef LIKE @q OR CAST(r.RequestID AS NVARCHAR(20)) = @qExact)`);
      params.q = `%${q}%`;
      params.qExact = q;
    }
    const rows = await executeQuery(
      `SELECT TOP 500 r.RequestID, r.RequestType, r.FullName, r.Mobile, r.Email, r.fPlanID, r.PlanName, r.DurationDays, r.Amount,
              r.TransactionRef, r.Notes, r.Status, r.Remarks, r.CreatedOn, r.ReviewedOn, r.fCreatedUID,
              sm.Name AS ReviewedByName
       FROM SubscriptionRequests r
       LEFT JOIN SuperManagers sm ON sm.SMID = r.fReviewedBy
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.RequestID DESC`,
      params
    );
    ok(res, { data: rows || [] });
  } catch (err) { fail(res, err); }
});

// GET /api/sm/requests/:id — includes screenshot + matching existing account.
router.get('/requests/:id', async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT r.*, sm.Name AS ReviewedByName FROM SubscriptionRequests r
       LEFT JOIN SuperManagers sm ON sm.SMID = r.fReviewedBy WHERE r.RequestID = @id`,
      { id: parseInt(req.params.id, 10) || 0 }
    );
    if (!rows || !rows.length) return bad(res, 'Request not found', 404);
    const r = rows[0];
    let existingUser = null;
    const u = await sub.findUserByMobile(r.Mobile);
    if (u) existingUser = { UID: u.UID, Mobile: u.Mobile, subscription: await sub.getSubscription(u.UID, { fresh: true }) };
    ok(res, { data: r, existingUser });
  } catch (err) { fail(res, err); }
});

// POST /api/sm/requests/:id/approve
// Body: { mobile?, password?, planId?, endDate?, remarks? }
//   • No account with that mobile → creates the Admin login (password required).
//   • Account exists → extends its subscription (password optional = reset).
router.post('/requests/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  let claimed = false;
  try {
    // Atomically claim the request so two managers can't approve it twice.
    const claim = await executeQuery(
      `UPDATE SubscriptionRequests SET Status = 'Processing', fReviewedBy = @smid
       OUTPUT INSERTED.RequestID, INSERTED.Mobile, INSERTED.FullName, INSERTED.fPlanID, INSERTED.Amount
       WHERE RequestID = @id AND Status = 'Pending'`,
      { id, smid: req.sm.SMID }
    );
    if (!claim || !claim.length) return bad(res, 'Request pending nahi hai (shayad pehle hi process ho chuki hai)', 409);
    claimed = true;
    const r = claim[0];

    const mobile = String(req.body.mobile || r.Mobile || '').replace(/\D/g, '');
    const password = req.body.password ? String(req.body.password).trim() : '';
    const endDate = req.body.endDate ? String(req.body.endDate) : null;
    const remarks = str(req.body.remarks);
    if (!MOBILE.test(mobile)) throw Object.assign(new Error('Mobile number 10 digit ka hona chahiye'), { status: 400 });
    if (endDate && !ISO_DATE.test(endDate)) throw Object.assign(new Error('End date galat hai'), { status: 400 });
    const plan = await sub.getPlan(req.body.planId || r.fPlanID);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 400 });

    let user = await sub.findUserByMobile(mobile);
    let created = false;
    if (!user) {
      if (password.length < 4) throw Object.assign(new Error('Naye account ke liye password (min 4 characters) required hai'), { status: 400 });
      const uid = await sub.createUserLogin(mobile, password);
      user = { UID: uid, Mobile: mobile };
      created = true;
    } else if (password) {
      if (password.length < 4) throw Object.assign(new Error('Password kam se kam 4 characters ka hona chahiye'), { status: 400 });
      await sub.setUserPassword(user.UID, password);
    }

    const grant = await sub.grantSubscription(user.UID, plan, {
      endDate, requestId: id, smid: req.sm.SMID, amount: r.Amount, remarks, fullName: r.FullName,
    });

    await executeQuery(
      `UPDATE SubscriptionRequests SET Status = 'Approved', fReviewedBy = @smid, ReviewedOn = GETDATE(),
              Remarks = @remarks, fCreatedUID = @uid WHERE RequestID = @id`,
      { id, smid: req.sm.SMID, remarks, uid: user.UID }
    );
    claimed = false;
    ok(res, {
      message: created ? 'Admin account create ho gaya' : 'Subscription extend ho gaya',
      created,
      uid: user.UID,
      mobile,
      password: password || null,
      startDate: grant?.StartDate,
      endDate: grant?.EndDate,
      planName: plan.PlanName,
    });
  } catch (err) {
    if (claimed) {
      try {
        await executeQuery(`UPDATE SubscriptionRequests SET Status = 'Pending' WHERE RequestID = @id AND Status = 'Processing'`, { id });
      } catch (e) { /* ignore */ }
    }
    if (err.status) return bad(res, err.message, err.status);
    fail(res, err);
  }
});

// POST /api/sm/requests/:id/reject { remarks }
router.post('/requests/:id/reject', async (req, res) => {
  try {
    const remarks = str(req.body.remarks);
    if (!remarks) return bad(res, 'Reject karne ka reason likhein (payer ko dikhega)');
    const rows = await executeQuery(
      `UPDATE SubscriptionRequests SET Status = 'Rejected', Remarks = @remarks, fReviewedBy = @smid, ReviewedOn = GETDATE()
       OUTPUT INSERTED.RequestID WHERE RequestID = @id AND Status = 'Pending'`,
      { id: parseInt(req.params.id, 10) || 0, remarks, smid: req.sm.SMID }
    );
    if (!rows || !rows.length) return bad(res, 'Request pending nahi hai', 409);
    ok(res, { message: 'Request rejected' });
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════════ Plans ═══════════════════════════════

router.get('/plans', async (req, res) => {
  try {
    const rows = await executeQuery(`
      SELECT p.*, (SELECT COUNT(*) FROM AdminAccounts a WHERE a.fPlanID = p.PlanID) AS AdminCount
      FROM SubscriptionPlans p ORDER BY p.SortOrder, p.Price`);
    ok(res, { data: rows || [] });
  } catch (err) { fail(res, err); }
});

function readPlan(body) {
  const plan = {
    name: str(body.planName, 100),
    days: parseInt(body.durationDays, 10),
    price: Number(body.price),
    maxSub: intOrNull(body.maxSubUsers),
    maxCust: intOrNull(body.maxCustomers),
    description: str(body.description, 500),
    isActive: body.isActive !== false && body.isActive !== 'false',
    sortOrder: parseInt(body.sortOrder, 10) || 0,
  };
  if (!plan.name) return { error: 'Plan name required hai' };
  if (!(plan.days > 0)) return { error: 'Duration (days) 1 ya zyada honi chahiye' };
  if (!Number.isFinite(plan.price) || plan.price < 0) return { error: 'Price sahi nahi hai' };
  if ((plan.maxSub !== null && plan.maxSub < 0) || (plan.maxCust !== null && plan.maxCust < 0)) return { error: 'Limits negative nahi ho sakti' };
  return { plan };
}

router.post('/plans', async (req, res) => {
  try {
    const { plan, error } = readPlan(req.body);
    if (error) return bad(res, error);
    const rows = await executeQuery(
      `INSERT INTO SubscriptionPlans (PlanName, DurationDays, Price, MaxSubUsers, MaxCustomers, Description, IsActive, SortOrder)
       OUTPUT INSERTED.PlanID VALUES (@name, @days, CAST(@price AS DECIMAL(18,2)), @maxSub, @maxCust, @description, @isActive, @sortOrder)`,
      { ...plan, price: String(plan.price) }
    );
    ok(res, { planId: rows?.[0]?.PlanID });
  } catch (err) { fail(res, err); }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const { plan, error } = readPlan(req.body);
    if (error) return bad(res, error);
    await executeQuery(
      `UPDATE SubscriptionPlans SET PlanName=@name, DurationDays=@days, Price=CAST(@price AS DECIMAL(18,2)), MaxSubUsers=@maxSub,
              MaxCustomers=@maxCust, Description=@description, IsActive=@isActive, SortOrder=@sortOrder, UpdatedOn=GETDATE()
       WHERE PlanID=@id`,
      { ...plan, price: String(plan.price), id: parseInt(req.params.id, 10) || 0 }
    );
    ok(res);
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════ Payment settings ═══════════════════════════

router.get('/payment-settings', async (req, res) => {
  try {
    const rows = await executeQuery(`SELECT * FROM PaymentSettings WHERE SettingID = 1`);
    ok(res, { data: rows?.[0] || {} });
  } catch (err) { fail(res, err); }
});

// PUT /api/sm/payment-settings — qrImage: data URL, '' to remove, undefined to keep.
router.put('/payment-settings', async (req, res) => {
  try {
    const b = req.body || {};
    let qr = b.qrImage;
    if (qr !== undefined && qr !== null && qr !== '') {
      qr = String(qr).trim();
      if (!IMAGE_DATA_URL.test(qr)) return bad(res, 'QR code PNG/JPG/WEBP image honi chahiye');
      if (qr.length > 3 * 1024 * 1024) return bad(res, 'QR image bahut badi hai (max ~2 MB)');
    }
    const params = {
      upi: str(b.upiId, 100), payee: str(b.payeeName, 150), bank: str(b.bankName, 150), holder: str(b.accountHolder, 150),
      acct: str(b.accountNumber, 50), ifsc: str(b.ifsc, 20), branch: str(b.branchName, 150),
      instructions: str(b.instructions, 1000), support: str(b.supportMobile, 20), smid: req.sm.SMID,
      keepQr: qr === undefined || qr === null, qr: qr || null,
    };
    await executeQuery(
      `IF NOT EXISTS (SELECT 1 FROM PaymentSettings WHERE SettingID = 1) INSERT INTO PaymentSettings (SettingID) VALUES (1);
       UPDATE PaymentSettings SET
         QrImage = CASE WHEN @keepQr = 1 THEN QrImage ELSE @qr END,
         UpiID=@upi, PayeeName=@payee, BankName=@bank, AccountHolder=@holder, AccountNumber=@acct, IFSC=@ifsc,
         BranchName=@branch, Instructions=@instructions, SupportMobile=@support, UpdatedOn=GETDATE(), fUpdatedBy=@smid
       WHERE SettingID = 1`,
      params
    );
    ok(res, { message: 'Payment settings saved' });
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════════ Admins ═══════════════════════════════

// GET /api/sm/admins?filter=all|active|expiring|expired|blocked&q=
router.get('/admins', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const q = str(req.query.q, 100);
    const where = [];
    const params = {};
    if (filter === 'active') where.push('a.IsBlocked = 0 AND a.EndDate >= @today');
    if (filter === 'expiring') where.push('a.IsBlocked = 0 AND a.EndDate >= @today AND a.EndDate <= DATEADD(day, 7, @today)');
    if (filter === 'expired') where.push('a.IsBlocked = 0 AND a.EndDate < @today');
    if (filter === 'blocked') where.push('a.IsBlocked = 1');
    if (q) { where.push('(u.Mobile LIKE @q OR a.FullName LIKE @q OR CAST(a.fUID AS NVARCHAR(20)) = @qExact)'); params.q = `%${q}%`; params.qExact = q; }
    const rows = await executeQuery(
      `DECLARE @today DATE = CAST(GETDATE() AS DATE);
       SELECT a.fUID AS UID, u.Mobile, a.FullName, a.fPlanID, p.PlanName, a.StartDate, a.EndDate, a.IsBlocked,
              a.MaxSubUsers, a.MaxCustomers, a.CreatedOn,
              DATEDIFF(day, @today, a.EndDate) AS DaysLeft,
              (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = a.fUID) AS SubUserCount,
              (SELECT COUNT(*) FROM Customers c WHERE c.fUID = a.fUID) AS CustomerCount
       FROM AdminAccounts a
       LEFT JOIN Users u ON u.UID = a.fUID
       LEFT JOIN SubscriptionPlans p ON p.PlanID = a.fPlanID
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.EndDate ASC`,
      params
    );
    ok(res, { data: rows || [] });
  } catch (err) { fail(res, err); }
});

// POST /api/sm/admins — create an Admin directly (e.g. cash payment).
// Body: { fullName?, mobile, password, planId, endDate?, amount?, remarks? }
router.post('/admins', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').replace(/\D/g, '');
    const password = String(req.body.password || '').trim();
    const endDate = req.body.endDate ? String(req.body.endDate) : null;
    if (!MOBILE.test(mobile)) return bad(res, 'Mobile number 10 digit ka hona chahiye');
    if (endDate && !ISO_DATE.test(endDate)) return bad(res, 'End date galat hai');
    const plan = await sub.getPlan(req.body.planId);
    if (!plan) return bad(res, 'Plan select karein');

    let user = await sub.findUserByMobile(mobile);
    let created = false;
    if (user) {
      const existing = await sub.getSubscription(user.UID, { fresh: true });
      if (existing && !req.body.attachExisting) {
        return bad(res, 'Is mobile ka Admin pehle se hai — Admins list se Extend use karein', 409);
      }
      if (password) {
        if (password.length < 4) return bad(res, 'Password kam se kam 4 characters ka hona chahiye');
        await sub.setUserPassword(user.UID, password);
      }
    } else {
      if (password.length < 4) return bad(res, 'Password kam se kam 4 characters ka hona chahiye');
      user = { UID: await sub.createUserLogin(mobile, password), Mobile: mobile };
      created = true;
    }
    const amount = req.body.amount === undefined || req.body.amount === '' ? null : Number(req.body.amount);
    const grant = await sub.grantSubscription(user.UID, plan, {
      endDate, smid: req.sm.SMID, amount, remarks: str(req.body.remarks), fullName: str(req.body.fullName, 150),
    });
    ok(res, { created, uid: user.UID, mobile, password: password || null, endDate: grant?.EndDate, planName: plan.PlanName });
  } catch (err) { fail(res, err); }
});

// POST /api/sm/admins/:uid/extend { planId, endDate?, amount?, remarks? }
router.post('/admins/:uid/extend', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const existing = await sub.getSubscription(uid, { fresh: true });
    if (!existing) return bad(res, 'Admin not found', 404);
    const endDate = req.body.endDate ? String(req.body.endDate) : null;
    if (endDate && !ISO_DATE.test(endDate)) return bad(res, 'End date galat hai');
    const plan = await sub.getPlan(req.body.planId || existing.planId);
    if (!plan) return bad(res, 'Plan select karein');
    const amount = req.body.amount === undefined || req.body.amount === '' ? null : Number(req.body.amount);
    const grant = await sub.grantSubscription(uid, plan, { endDate, smid: req.sm.SMID, amount, remarks: str(req.body.remarks) });
    ok(res, { endDate: grant?.EndDate });
  } catch (err) { fail(res, err); }
});

// POST /api/sm/admins/:uid/block { blocked: true|false, remarks? }
router.post('/admins/:uid/block', async (req, res) => {
  try {
    const done = await sub.setBlocked(req.params.uid, !!req.body.blocked, { smid: req.sm.SMID, remarks: str(req.body.remarks) });
    if (!done) return bad(res, 'Admin not found', 404);
    ok(res);
  } catch (err) { fail(res, err); }
});

// POST /api/sm/admins/:uid/reset-password { newPassword }
router.post('/admins/:uid/reset-password', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const pwd = String(req.body.newPassword || '').trim();
    if (pwd.length < 4) return bad(res, 'Password kam se kam 4 characters ka hona chahiye');
    if (!(await sub.getSubscription(uid, { fresh: true }))) return bad(res, 'Admin not found', 404);
    await sub.setUserPassword(uid, pwd);
    ok(res, { message: 'Password reset ho gaya' });
  } catch (err) { fail(res, err); }
});

// GET /api/sm/admins/:uid/history
router.get('/admins/:uid/history', async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT h.*, sm.Name AS ByName FROM SubscriptionHistory h
       LEFT JOIN SuperManagers sm ON sm.SMID = h.fCreatedBy
       WHERE h.fUID = @uid ORDER BY h.HistoryID DESC`,
      { uid: parseInt(req.params.uid, 10) || 0 }
    );
    ok(res, { data: rows || [] });
  } catch (err) { fail(res, err); }
});

// ═══════════════════════════ Super Managers ═══════════════════════════

router.get('/managers', async (req, res) => {
  try {
    const rows = await executeQuery(`
      SELECT m.SMID, m.Name, m.Mobile, m.IsActive, m.CreatedOn, m.LastLoginOn, c.Name AS CreatedByName
      FROM SuperManagers m LEFT JOIN SuperManagers c ON c.SMID = m.fCreatedBy ORDER BY m.SMID`);
    ok(res, { data: rows || [] });
  } catch (err) { fail(res, err); }
});

// POST /api/sm/managers { name, mobile, password }
router.post('/managers', async (req, res) => {
  try {
    const name = str(req.body.name, 100);
    const mobile = String(req.body.mobile || '').replace(/\D/g, '');
    const password = String(req.body.password || '');
    if (!name) return bad(res, 'Name required hai');
    if (!MOBILE.test(mobile)) return bad(res, 'Mobile number 10 digit ka hona chahiye');
    if (password.length < 6) return bad(res, 'Password kam se kam 6 characters ka hona chahiye');
    const dup = await executeQuery(`SELECT SMID FROM SuperManagers WHERE Mobile = @mobile`, { mobile });
    if (dup.length) return bad(res, 'Is mobile ka Super Manager pehle se hai', 409);
    const hash = await bcrypt.hash(password, 10);
    const rows = await executeQuery(
      `INSERT INTO SuperManagers (Name, Mobile, PasswordHash, IsActive, fCreatedBy) OUTPUT INSERTED.SMID VALUES (@name, @mobile, @hash, 1, @by)`,
      { name, mobile, hash, by: req.sm.SMID }
    );
    ok(res, { smid: rows?.[0]?.SMID });
  } catch (err) { fail(res, err); }
});

// PUT /api/sm/managers/:id { name?, isActive?, password? }
router.put('/managers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const sets = [];
    const params = { id };
    if (req.body.name !== undefined) {
      const name = str(req.body.name, 100);
      if (!name) return bad(res, 'Name required hai');
      sets.push('Name = @name'); params.name = name;
    }
    if (req.body.isActive !== undefined) {
      const active = req.body.isActive === true || req.body.isActive === 'true';
      if (!active && id === req.sm.SMID) return bad(res, 'Aap khud ko deactivate nahi kar sakte');
      if (!active) {
        const others = await executeQuery(`SELECT COUNT(*) AS cnt FROM SuperManagers WHERE IsActive = 1 AND SMID <> @id`, { id });
        if (!(others?.[0]?.cnt > 0)) return bad(res, 'Kam se kam ek active Super Manager hona zaroori hai');
      }
      sets.push('IsActive = @active'); params.active = active;
    }
    if (req.body.password) {
      if (String(req.body.password).length < 6) return bad(res, 'Password kam se kam 6 characters ka hona chahiye');
      sets.push('PasswordHash = @hash'); params.hash = await bcrypt.hash(String(req.body.password), 10);
    }
    if (!sets.length) return bad(res, 'Kuch update karne ko nahi hai');
    await executeQuery(`UPDATE SuperManagers SET ${sets.join(', ')} WHERE SMID = @id`, params);
    invalidateSuperManager(id);
    ok(res);
  } catch (err) { fail(res, err); }
});

module.exports = router;
