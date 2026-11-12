// Subscription model helpers shared by auth middleware, the public subscribe
// API and the Super Manager API.
//
// Model:
//   • AdminAccounts row  → the Users.UID is a subscribed Admin; access is
//     allowed while EndDate >= today and IsBlocked = 0.
//   • No AdminAccounts row → legacy account (pre-subscription admins and
//     customer logins). Never restricted by this module.
const { executeQuery, executeStoredProcedure } = require('../config/database');

// ── Status cache ───────────────────────────────────────────────────────────
// requireAuth runs on every API call (some screens poll every few seconds),
// so cache lookups briefly. Mutations below call invalidate() so changes made
// through this process apply immediately.
const CACHE_MS = 60 * 1000;
const cache = new Map(); // uid -> { at, value }
let tablesMissingLogged = false;

function invalidate(uid) {
  if (uid === undefined) cache.clear();
  else cache.delete(String(uid));
}

const SUB_SELECT = `
  SELECT a.fUID, a.FullName, a.fPlanID, p.PlanName, p.Price,
         a.StartDate, a.EndDate, a.IsBlocked, a.MaxSubUsers, a.MaxCustomers,
         DATEDIFF(day, CAST(GETDATE() AS DATE), a.EndDate) AS DaysLeft
  FROM AdminAccounts a
  LEFT JOIN SubscriptionPlans p ON p.PlanID = a.fPlanID`;

function shape(row) {
  if (!row) return null;
  const blocked = row.IsBlocked === true || row.IsBlocked === 1;
  const daysLeft = Number(row.DaysLeft);
  const state = blocked ? 'blocked' : daysLeft < 0 ? 'expired' : 'active';
  return {
    uid: row.fUID,
    fullName: row.FullName || null,
    planId: row.fPlanID,
    planName: row.PlanName || null,
    startDate: row.StartDate,
    endDate: row.EndDate,
    daysLeft,
    state,
    isActive: state === 'active',
    maxSubUsers: row.MaxSubUsers ?? null,
    maxCustomers: row.MaxCustomers ?? null,
  };
}

// Returns null for legacy (unsubscribed) accounts.
async function getSubscription(uid, { fresh = false } = {}) {
  if (uid === undefined || uid === null || uid === '') return null;
  const key = String(uid);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = null;
  try {
    const rows = await executeQuery(`${SUB_SELECT} WHERE a.fUID = @uid`, { uid: parseInt(uid, 10) || 0 });
    value = shape(rows && rows[0]);
  } catch (err) {
    // Migration not applied yet → behave exactly like the pre-subscription app.
    if (!tablesMissingLogged) {
      console.warn('[subscription] lookup failed (has migrations/001 been applied?):', err.message);
      tablesMissingLogged = true;
    }
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

function denialFor(sub) {
  if (!sub || sub.isActive) return null;
  if (sub.state === 'blocked') {
    return { code: 'ACCOUNT_BLOCKED', message: 'Aapka account block kar diya gaya hai. Support se contact karein.' };
  }
  return {
    code: 'SUBSCRIPTION_EXPIRED',
    message: 'Aapka subscription expire ho gaya hai. Portal use karne ke liye plan renew karein.',
  };
}

// ── Users table compatibility ──────────────────────────────────────────────
// The legacy code base is inconsistent about Users column names
// (Validity vs ValidityDate, Status vs IsActive), so detect them once.
let userCols = null;
async function getUserColumns() {
  if (userCols) return userCols;
  const rows = await executeQuery(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Users' AND TABLE_SCHEMA = 'dbo'`
  );
  const byLower = new Map((rows || []).map((r) => [String(r.COLUMN_NAME).toLowerCase(), r.COLUMN_NAME]));
  userCols = {
    validity: byLower.get('validity') || byLower.get('validitydate') || null,
    status: byLower.get('status') || null,
    isActive: byLower.get('isactive') || null,
  };
  return userCols;
}

async function findUserByMobile(mobile) {
  const rows = await executeQuery(
    `SELECT TOP 1 UID, Mobile FROM Users WHERE Mobile = @mobile ORDER BY UID ASC`,
    { mobile: String(mobile).trim() }
  );
  return rows && rows[0] ? rows[0] : null;
}

// Creates a Users login through the same SP the legacy signup uses.
async function createUserLogin(mobile, password) {
  const result = await executeStoredProcedure('UserSignUP', { Mobile: mobile, Password: password, Validity: '' });
  let uid = result?.[0]?.UID || result?.[0]?.[''] || null;
  if (!uid) {
    const u = await findUserByMobile(mobile);
    uid = u ? u.UID : null;
  }
  if (!uid) throw new Error('User account create nahi ho paya');
  return parseInt(uid, 10);
}

async function setUserPassword(uid, password) {
  await executeQuery(`UPDATE Users SET Password = @pwd WHERE UID = @uid`, { uid: parseInt(uid, 10), pwd: password });
}

// Mirror AdminAccounts state onto the legacy Users columns so the existing
// `Login` stored procedure (which checks Status + Validity) agrees with us.
async function syncUserAccess(uid) {
  const cols = await getUserColumns();
  const sets = [];
  if (cols.status) sets.push(`u.[${cols.status}] = CASE WHEN a.IsBlocked = 1 THEN 'False' ELSE 'True' END`);
  if (cols.isActive) sets.push(`u.[${cols.isActive}] = CASE WHEN a.IsBlocked = 1 THEN 'False' ELSE 'True' END`);
  if (cols.validity) sets.push(`u.[${cols.validity}] = DATEADD(second, -1, DATEADD(day, 1, CAST(a.EndDate AS DATETIME)))`);
  if (!sets.length) return;
  await executeQuery(
    `UPDATE u SET ${sets.join(', ')} FROM Users u INNER JOIN AdminAccounts a ON a.fUID = u.UID WHERE u.UID = @uid`,
    { uid: parseInt(uid, 10) }
  );
}

async function getPlan(planId) {
  const rows = await executeQuery(`SELECT * FROM SubscriptionPlans WHERE PlanID = @id`, { id: parseInt(planId, 10) || 0 });
  return rows && rows[0] ? rows[0] : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Start or extend a subscription.
//   • New admin:           StartDate = today, EndDate = today + days - 1
//   • Active admin:        EndDate  += days (time is never lost on early renewal)
//   • Expired admin:       restarts from today
//   • opts.endDate (YYYY-MM-DD) overrides the computed end date.
async function grantSubscription(uid, plan, opts = {}) {
  const { endDate = null, requestId = null, smid = null, amount = null, remarks = null, fullName = null } = opts;
  if (endDate && !ISO_DATE.test(endDate)) throw new Error('End date format YYYY-MM-DD hona chahiye');
  const days = parseInt(plan.DurationDays, 10);
  if (!(days > 0) && !endDate) throw new Error('Plan duration invalid hai');

  const params = {
    uid: parseInt(uid, 10),
    planId: plan.PlanID,
    planName: plan.PlanName,
    days: days || 0,
    endDate,
    maxSub: plan.MaxSubUsers ?? null,
    maxCust: plan.MaxCustomers ?? null,
    smid,
    requestId,
    amount: amount === null || amount === undefined ? (plan.Price === null ? null : Number(plan.Price)) : Number(amount),
    remarks,
    fullName,
  };

  const rows = await executeQuery(
    `DECLARE @today DATE = CAST(GETDATE() AS DATE);
     DECLARE @action NVARCHAR(20) = 'CREATE';
     IF EXISTS (SELECT 1 FROM AdminAccounts WHERE fUID = @uid)
     BEGIN
       SET @action = 'RENEW';
       UPDATE AdminAccounts SET
         fPlanID = @planId,
         FullName = COALESCE(@fullName, FullName),
         MaxSubUsers = @maxSub,
         MaxCustomers = @maxCust,
         StartDate = CASE WHEN EndDate < @today THEN @today ELSE StartDate END,
         EndDate = COALESCE(CAST(@endDate AS DATE),
                     DATEADD(day, @days, CASE WHEN EndDate >= @today THEN EndDate ELSE DATEADD(day, -1, @today) END)),
         IsBlocked = 0,
         UpdatedOn = GETDATE()
       WHERE fUID = @uid;
     END
     ELSE
     BEGIN
       INSERT INTO AdminAccounts (fUID, FullName, fPlanID, StartDate, EndDate, IsBlocked, MaxSubUsers, MaxCustomers, fCreatedBy)
       VALUES (@uid, @fullName, @planId, @today,
               COALESCE(CAST(@endDate AS DATE), DATEADD(day, @days - 1, @today)),
               0, @maxSub, @maxCust, @smid);
     END
     INSERT INTO SubscriptionHistory (fUID, fPlanID, PlanName, Amount, DurationDays, StartDate, EndDate, Action, fRequestID, fCreatedBy, Remarks)
     SELECT fUID, @planId, @planName, @amount, @days, StartDate, EndDate, @action, @requestId, @smid, @remarks
     FROM AdminAccounts WHERE fUID = @uid;
     SELECT fUID, StartDate, EndDate, @action AS Action FROM AdminAccounts WHERE fUID = @uid;`,
    params
  );
  await syncUserAccess(uid);
  invalidate(uid);
  return rows && rows[0];
}

async function setBlocked(uid, blocked, { smid = null, remarks = null } = {}) {
  const rows = await executeQuery(
    `UPDATE AdminAccounts SET IsBlocked = @blocked, UpdatedOn = GETDATE() OUTPUT INSERTED.fUID WHERE fUID = @uid`,
    { uid: parseInt(uid, 10), blocked: !!blocked }
  );
  if (!rows || !rows.length) return false;
  await executeQuery(
    `INSERT INTO SubscriptionHistory (fUID, Action, fCreatedBy, Remarks) VALUES (@uid, @action, @smid, @remarks)`,
    { uid: parseInt(uid, 10), action: blocked ? 'BLOCK' : 'UNBLOCK', smid, remarks }
  );
  await syncUserAccess(uid);
  invalidate(uid);
  return true;
}

// ── Plan limits ────────────────────────────────────────────────────────────
// Returns an error message when the admin is at their plan limit, else null.
async function checkLimit(uid, kind) {
  const sub = await getSubscription(uid, { fresh: true });
  if (!sub) return null;
  const max = kind === 'subusers' ? sub.maxSubUsers : sub.maxCustomers;
  if (max === null || max === undefined) return null;
  const q = kind === 'subusers'
    ? `SELECT COUNT(*) AS cnt FROM subusers WHERE fcreatedUID = @uid`
    : `SELECT COUNT(*) AS cnt FROM Customers WHERE fUID = @uid`;
  const rows = await executeQuery(q, { uid: parseInt(uid, 10) });
  const used = rows?.[0]?.cnt || 0;
  if (used >= max) {
    const label = kind === 'subusers' ? 'sub users' : 'customers';
    return `Aapke plan (${sub.planName || 'current'}) mein maximum ${max} ${label} allowed hain. Zyada ke liye plan upgrade karein.`;
  }
  return null;
}

module.exports = {
  getSubscription,
  denialFor,
  invalidate,
  getUserColumns,
  findUserByMobile,
  createUserLogin,
  setUserPassword,
  syncUserAccess,
  getPlan,
  grantSubscription,
  setBlocked,
  checkLimit,
  shape,
  SUB_SELECT,
};
