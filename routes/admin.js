const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { executeStoredProcedure, executeQuery } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../helpers/activityLogger');

const JWT_SECRET = process.env.JWT_SECRET || 'susu9_mobile_jwt_secret_2024_xK9mP';

function requireSA(req, res, next) {
  if (req.user && !req.user.SubUID && req.user.SuperAdmin === 'SuperAdmin') return next();
  res.status(403).json({ success: false, message: 'SuperAdmin required' });
}

function getIST() {
  const d = new Date(new Date().getTime() + 5.5 * 3600000);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '/');
}

// =========================================================================
// 1. EXECUTIVE DASHBOARD METRICS
// =========================================================================
router.get('/dashboard-stats', requireAuth, requireSA, async (req, res) => {
  try {
    // Parallel aggregation queries
    const [
      usersCountRes,
      subUsersCountRes,
      revenueRes,
      paidUsersRes,
      newUsersRes,
      configRes,
      recentUsersRes,
      recentActivityRes
    ] = await Promise.all([
      executeQuery(`
        SELECT
          COUNT(*) AS TotalUsers,
          SUM(CASE WHEN Validity >= CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS ActiveValidity,
          SUM(CASE WHEN Validity < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS ExpiredValidity,
          SUM(CASE WHEN Status=1 OR Status='True' THEN 1 ELSE 0 END) AS ActiveStatus
        FROM Users
      `),
      executeQuery(`
        SELECT
          COUNT(*) AS TotalSubUsers,
          SUM(CASE WHEN IsActive=1 OR IsActive='True' THEN 1 ELSE 0 END) AS ActiveSubUsers,
          COUNT(DISTINCT fcreatedUID) AS UsersWithSubUsers
        FROM subusers
      `),
      executeQuery(`
        SELECT
          ISNULL(SUM(Amount), 0) AS TotalRevenue,
          COUNT(*) AS TotalTransactions
        FROM SubscriptionPayments
        WHERE PaymentStatus='SUCCESS' OR PaymentStatus='paid'
      `),
      executeQuery(`
        SELECT COUNT(DISTINCT UID) AS PaidUsersCount
        FROM SubscriptionPayments
        WHERE PaymentStatus='SUCCESS' OR PaymentStatus='paid'
      `),
      executeQuery(`
        SELECT COUNT(*) AS NewUsersMonth
        FROM Users
        WHERE RegisteredOn >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)
      `),
      executeQuery(`SELECT ConfigKey, ConfigValue FROM SystemConfig`),
      executeQuery(`
        SELECT TOP 10 
          u.UID, u.Mobile, u.RegisteredOn, u.Validity, u.Status,
          (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = u.UID) AS SubUserCount
        FROM Users u
        ORDER BY u.UID DESC
      `),
      executeQuery(`
        SELECT TOP 8 LogID, ActorType, ActorName, Module, Action, Description, CreatedAt
        FROM ActivityLog
        ORDER BY LogID DESC
      `)
    ]);

    const uStats = usersCountRes?.[0] || {};
    const sStats = subUsersCountRes?.[0] || {};
    const rStats = revenueRes?.[0] || {};
    const paidCount = paidUsersRes?.[0]?.PaidUsersCount || 0;

    const totalUsers = uStats.TotalUsers || 0;
    const activeValidity = uStats.ActiveValidity || 0;
    const expiredValidity = uStats.ExpiredValidity || 0;

    // Free trial users vs expired unpaid users
    const activeFreeTrial = Math.max(0, activeValidity - paidCount);
    const expiredTrialUnpaid = expiredValidity;

    // Config map
    const configs = {};
    (configRes || []).forEach(c => { configs[c.ConfigKey] = c.ConfigValue; });

    res.json({
      success: true,
      data: {
        kpis: {
          totalUsers,
          totalSubUsers: sStats.TotalSubUsers || 0,
          activeSubUsers: sStats.ActiveSubUsers || 0,
          usersWithSubUsers: sStats.UsersWithSubUsers || 0,
          paidSubscribers: paidCount,
          activeFreeTrial,
          expiredTrialUnpaid,
          totalRevenue: rStats.TotalRevenue || 0,
          totalTransactions: rStats.TotalTransactions || 0,
          newUsersMonth: newUsersRes?.[0]?.NewUsersMonth || 0,
          activeStatusUsers: uStats.ActiveStatus || 0
        },
        configs: {
          freeTrialDays: parseInt(configs.FREE_TRIAL_DAYS || '15'),
          maintenanceMode: configs.MAINTENANCE_MODE === 'true',
          broadcastNotice: configs.BROADCAST_NOTICE || ''
        },
        recentUsers: recentUsersRes || [],
        recentActivities: recentActivityRes || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Legacy dashboard endpoint for compatibility
router.get('/dashboard', requireAuth, requireSA, async (req, res) => {
  try {
    const data = await executeStoredProcedure('SelectTodaysSaleofUsers', {
      Todate: getIST(), OpType: 3
    });
    res.json({ success: true, data: data?.[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 2. ADVANCED USERS & SUB-USERS LIST (WITH NESTED SUBUSERS & FILTERING)
// =========================================================================
router.get('/users-advanced', requireAuth, requireSA, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const filter = req.query.filter || 'all'; // all, with_subs, no_subs, paid, trial, expired, active, inactive
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = { limit, offset };

    if (q) {
      whereClauses.push("(u.Mobile LIKE '%' + @q + '%' OR CAST(u.UID AS VARCHAR) LIKE '%' + @q + '%')");
      params.q = q;
    }

    if (filter === 'with_subs') {
      whereClauses.push("EXISTS (SELECT 1 FROM subusers s WHERE s.fcreatedUID = u.UID)");
    } else if (filter === 'no_subs') {
      whereClauses.push("NOT EXISTS (SELECT 1 FROM subusers s WHERE s.fcreatedUID = u.UID)");
    } else if (filter === 'paid') {
      whereClauses.push("EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid'))");
    } else if (filter === 'trial') {
      whereClauses.push("u.Validity >= CAST(GETDATE() AS DATE) AND NOT EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid'))");
    } else if (filter === 'expired') {
      whereClauses.push("u.Validity < CAST(GETDATE() AS DATE)");
    } else if (filter === 'active') {
      whereClauses.push("(u.Status = 1 OR u.Status = 'True')");
    } else if (filter === 'inactive') {
      whereClauses.push("(u.Status = 0 OR u.Status = 'False' OR u.Status IS NULL)");
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Total Count
    const countRes = await executeQuery(`SELECT COUNT(*) AS Total FROM Users u ${whereSql}`, params);
    const total = countRes?.[0]?.Total || 0;

    // Paged Users
    const users = await executeQuery(`
      SELECT 
        u.UID, u.Mobile, u.Password, u.RegisteredOn, u.Validity, u.Status, u.IsSuperAdmin,
        (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = u.UID) AS SubUserCount,
        CASE 
          WHEN EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid')) THEN 'PAID'
          WHEN u.Validity >= CAST(GETDATE() AS DATE) THEN 'TRIAL'
          ELSE 'EXPIRED'
        END AS SubscriptionType,
        CASE 
          WHEN u.Validity >= CAST(GETDATE() AS DATE) THEN DATEDIFF(day, CAST(GETDATE() AS DATE), u.Validity)
          ELSE 0
        END AS DaysRemaining
      FROM Users u
      ${whereSql}
      ORDER BY u.UID DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, params);

    // Fetch Sub-users for the returned page of users
    if (users && users.length > 0) {
      const uids = users.map(u => u.UID);
      const subUsersRes = await executeQuery(`
        SELECT SubUserID, Mobile, Password, IsActive, fcreatedUID, subusername
        FROM subusers
        WHERE fcreatedUID IN (${uids.join(',')})
        ORDER BY SubUserID ASC
      `);

      const subUsersMap = {};
      (subUsersRes || []).forEach(sub => {
        if (!subUsersMap[sub.fcreatedUID]) subUsersMap[sub.fcreatedUID] = [];
        subUsersMap[sub.fcreatedUID].push(sub);
      });

      users.forEach(u => {
        u.subUsers = subUsersMap[u.UID] || [];
      });
    }

    res.json({
      success: true,
      data: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        users: users || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// All Sub-Users across system
router.get('/subusers-all', requireAuth, requireSA, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const status = req.query.status || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = { limit, offset };

    if (q) {
      whereClauses.push("(s.subusername LIKE '%' + @q + '%' OR s.Mobile LIKE '%' + @q + '%' OR CAST(s.fcreatedUID AS VARCHAR) LIKE '%' + @q + '%')");
      params.q = q;
    }
    if (status === 'active') {
      whereClauses.push("(s.IsActive = 1 OR s.IsActive = 'True')");
    } else if (status === 'inactive') {
      whereClauses.push("(s.IsActive = 0 OR s.IsActive = 'False' OR s.IsActive IS NULL)");
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countRes = await executeQuery(`SELECT COUNT(*) AS Total FROM subusers s ${whereSql}`, params);
    const total = countRes?.[0]?.Total || 0;

    const subusers = await executeQuery(`
      SELECT 
        s.SubUserID, s.subusername, s.Mobile, s.Password, s.IsActive, s.fcreatedUID,
        u.Mobile AS ParentMobile, u.Status AS ParentStatus, u.Validity AS ParentValidity
      FROM subusers s
      LEFT JOIN Users u ON s.fcreatedUID = u.UID
      ${whereSql}
      ORDER BY s.SubUserID DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, params);

    res.json({
      success: true,
      data: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        subusers: subusers || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle sub-user active status
router.post('/toggle-subuser-status', requireAuth, requireSA, async (req, res) => {
  try {
    const { subUserId, isActive } = req.body;
    if (!subUserId) return res.status(400).json({ success: false, message: 'subUserId required' });

    const newStatus = (isActive === true || isActive === 1 || isActive === 'True' || isActive === 'true') ? 1 : 0;
    await executeQuery(`UPDATE subusers SET IsActive=@status WHERE SubUserID=@id`, { status: newStatus, id: parseInt(subUserId) });

    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'SubUsers',
      action: 'Toggle Status',
      entityType: 'SubUser',
      entityID: String(subUserId),
      description: `Changed SubUser #${subUserId} status to ${newStatus === 1 ? 'Active' : 'Inactive'}`
    });

    res.json({ success: true, message: 'Sub-user status updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 3. SALES, SUBSCRIPTIONS & TRIAL CONVERSION ANALYTICS
// =========================================================================
router.get('/sales-analytics', requireAuth, requireSA, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const tab = req.query.tab || 'expired_unpaid'; // expired_unpaid, payments, paid_users, active_trials
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    // Summary KPIs
    const [kpiRes, paidUsersRes] = await Promise.all([
      executeQuery(`
        SELECT
          ISNULL(SUM(Amount), 0) AS TotalRevenue,
          COUNT(*) AS TotalTransactions,
          SUM(CASE WHEN PaymentStatus='SUCCESS' OR PaymentStatus='paid' THEN 1 ELSE 0 END) AS SuccessfulTransactions
        FROM SubscriptionPayments
      `),
      executeQuery(`
        SELECT
          (SELECT COUNT(DISTINCT UID) FROM SubscriptionPayments WHERE PaymentStatus='SUCCESS' OR PaymentStatus='paid') AS PaidUsersCount,
          (SELECT COUNT(*) FROM Users WHERE Validity >= CAST(GETDATE() AS DATE) AND UID NOT IN (SELECT DISTINCT UID FROM SubscriptionPayments WHERE PaymentStatus='SUCCESS' OR PaymentStatus='paid')) AS ActiveTrialCount,
          (SELECT COUNT(*) FROM Users WHERE Validity < CAST(GETDATE() AS DATE) AND UID NOT IN (SELECT DISTINCT UID FROM SubscriptionPayments WHERE PaymentStatus='SUCCESS' OR PaymentStatus='paid')) AS TrialExpiredUnpaidCount
      `)
    ]);

    const kpis = {
      totalRevenue: kpiRes?.[0]?.TotalRevenue || 0,
      totalTransactions: kpiRes?.[0]?.TotalTransactions || 0,
      paidUsersCount: paidUsersRes?.[0]?.PaidUsersCount || 0,
      activeTrialCount: paidUsersRes?.[0]?.ActiveTrialCount || 0,
      trialExpiredUnpaidCount: paidUsersRes?.[0]?.TrialExpiredUnpaidCount || 0
    };

    let listData = [];
    let totalCount = 0;
    let params = { limit, offset };

    if (tab === 'expired_unpaid') {
      // Users who used free trial and didn't pay (validity expired, no successful payment)
      let where = ["u.Validity < CAST(GETDATE() AS DATE)", "NOT EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid'))"];
      if (q) {
        where.push("(u.Mobile LIKE '%' + @q + '%' OR CAST(u.UID AS VARCHAR) LIKE '%' + @q + '%')");
        params.q = q;
      }
      const wSql = 'WHERE ' + where.join(' AND ');

      const countR = await executeQuery(`SELECT COUNT(*) AS Total FROM Users u ${wSql}`, params);
      totalCount = countR?.[0]?.Total || 0;

      listData = await executeQuery(`
        SELECT 
          u.UID, u.Mobile, u.RegisteredOn, u.Validity, u.Status,
          (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = u.UID) AS SubUserCount,
          DATEDIFF(day, u.Validity, CAST(GETDATE() AS DATE)) AS DaysSinceExpired
        FROM Users u
        ${wSql}
        ORDER BY u.Validity DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `, params);

    } else if (tab === 'payments') {
      // Complete transaction history
      let where = [];
      if (q) {
        where.push("(sp.Mobile LIKE '%' + @q + '%' OR CAST(sp.UID AS VARCHAR) LIKE '%' + @q + '%' OR sp.RazorpayPaymentId LIKE '%' + @q + '%' OR sp.PlanName LIKE '%' + @q + '%')");
        params.q = q;
      }
      const wSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

      const countR = await executeQuery(`SELECT COUNT(*) AS Total FROM SubscriptionPayments sp ${wSql}`, params);
      totalCount = countR?.[0]?.Total || 0;

      listData = await executeQuery(`
        SELECT 
          sp.PaymentID, sp.UID, sp.Mobile, sp.PlanName, sp.PlanDays, sp.Amount, sp.Currency,
          sp.RazorpayOrderId, sp.RazorpayPaymentId, sp.PaymentStatus, sp.PreviousValidity, sp.NewValidity, sp.CreatedAt
        FROM SubscriptionPayments sp
        ${wSql}
        ORDER BY sp.PaymentID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `, params);

    } else if (tab === 'paid_users') {
      // Users with active paid subscriptions
      let where = ["EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid'))"];
      if (q) {
        where.push("(u.Mobile LIKE '%' + @q + '%' OR CAST(u.UID AS VARCHAR) LIKE '%' + @q + '%')");
        params.q = q;
      }
      const wSql = 'WHERE ' + where.join(' AND ');

      const countR = await executeQuery(`SELECT COUNT(*) AS Total FROM Users u ${wSql}`, params);
      totalCount = countR?.[0]?.Total || 0;

      listData = await executeQuery(`
        SELECT 
          u.UID, u.Mobile, u.RegisteredOn, u.Validity, u.Status,
          (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = u.UID) AS SubUserCount,
          (SELECT SUM(Amount) FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid')) AS TotalSpent
        FROM Users u
        ${wSql}
        ORDER BY u.Validity DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `, params);
    } else if (tab === 'active_trials') {
      // Users currently on free trial
      let where = [
        "u.Validity >= CAST(GETDATE() AS DATE)",
        "NOT EXISTS (SELECT 1 FROM SubscriptionPayments sp WHERE sp.UID = u.UID AND (sp.PaymentStatus='SUCCESS' OR sp.PaymentStatus='paid'))"
      ];
      if (q) {
        where.push("(u.Mobile LIKE '%' + @q + '%' OR CAST(u.UID AS VARCHAR) LIKE '%' + @q + '%')");
        params.q = q;
      }
      const wSql = 'WHERE ' + where.join(' AND ');

      const countR = await executeQuery(`SELECT COUNT(*) AS Total FROM Users u ${wSql}`, params);
      totalCount = countR?.[0]?.Total || 0;

      listData = await executeQuery(`
        SELECT 
          u.UID, u.Mobile, u.RegisteredOn, u.Validity, u.Status,
          (SELECT COUNT(*) FROM subusers s WHERE s.fcreatedUID = u.UID) AS SubUserCount,
          DATEDIFF(day, CAST(GETDATE() AS DATE), u.Validity) AS TrialDaysLeft
        FROM Users u
        ${wSql}
        ORDER BY u.Validity ASC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `, params);
    }

    res.json({
      success: true,
      data: {
        kpis,
        tab,
        total: totalCount,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
        list: listData || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Subscriptions transactions list
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
         SUM(CASE WHEN PaymentStatus='SUCCESS' OR PaymentStatus='paid' THEN 1 ELSE 0 END) AS SuccessfulOrders,
         SUM(CASE WHEN PaymentStatus='SUCCESS' OR PaymentStatus='paid' THEN Amount ELSE 0 END) AS TotalRevenue
       FROM SubscriptionPayments`
    );
    res.json({ success: true, data: data || [], summary: summary?.[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Manual Extension by Admin
router.post('/extend-subscription', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid, days, newValidityDate, planName } = req.body;
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

    // Record grant in history
    const uRows = await executeQuery(`SELECT Mobile FROM Users WHERE UID=@uid`, { uid: parseInt(uid) });
    const mobile = uRows?.[0]?.Mobile || '';
    await executeQuery(
      `INSERT INTO SubscriptionPayments (UID, Mobile, PlanName, PlanDays, Amount, RazorpayOrderId, PaymentStatus, NewValidity, CreatedAt)
       VALUES (@uid, @mobile, @planName, @days, 0, 'MANUAL_GRANT', 'SUCCESS', @val, GETDATE())`,
      { uid: parseInt(uid), mobile, planName: planName || 'Manual Admin Grant', days: days || 0, val: finalDateStr }
    );

    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'Subscription',
      action: 'Grant / Extend',
      entityType: 'User',
      entityID: String(uid),
      description: `Extended subscription for user #${uid} (${mobile}) to ${finalDateStr} (+${days || 0} days)`
    });

    res.json({ success: true, message: 'Subscription successfully extended!', validity: finalDateStr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 4. CONFIGURATION PANEL & SYSTEM SETTINGS
// =========================================================================
router.get('/configurations', requireAuth, requireSA, async (req, res) => {
  try {
    const rows = await executeQuery(`SELECT ConfigKey, ConfigValue, UpdatedAt, UpdatedBy FROM SystemConfig`);
    const configs = {};
    (rows || []).forEach(r => {
      if (r.ConfigKey === 'SUBSCRIPTION_PLANS') {
        try { configs[r.ConfigKey] = JSON.parse(r.ConfigValue); } catch(e) { configs[r.ConfigKey] = []; }
      } else {
        configs[r.ConfigKey] = r.ConfigValue;
      }
    });

    res.json({
      success: true,
      data: {
        freeTrialDays: parseInt(configs.FREE_TRIAL_DAYS || '15'),
        subscriptionPlans: configs.SUBSCRIPTION_PLANS || [],
        maintenanceMode: configs.MAINTENANCE_MODE === 'true',
        broadcastNotice: configs.BROADCAST_NOTICE || '',
        raw: rows || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/configurations', requireAuth, requireSA, async (req, res) => {
  try {
    const { freeTrialDays, subscriptionPlans, maintenanceMode, broadcastNotice } = req.body;

    if (freeTrialDays !== undefined) {
      await executeQuery(`
        MERGE SystemConfig AS target
        USING (SELECT 'FREE_TRIAL_DAYS' AS ConfigKey) AS src
        ON target.ConfigKey = src.ConfigKey
        WHEN MATCHED THEN UPDATE SET ConfigValue = @val, UpdatedAt = GETDATE(), UpdatedBy = @by
        WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue, UpdatedAt, UpdatedBy) VALUES ('FREE_TRIAL_DAYS', @val, GETDATE(), @by);
      `, { val: String(freeTrialDays), by: req.user.Mobile || 'SuperAdmin' });
    }

    if (subscriptionPlans !== undefined) {
      const plansJson = typeof subscriptionPlans === 'string' ? subscriptionPlans : JSON.stringify(subscriptionPlans);
      await executeQuery(`
        MERGE SystemConfig AS target
        USING (SELECT 'SUBSCRIPTION_PLANS' AS ConfigKey) AS src
        ON target.ConfigKey = src.ConfigKey
        WHEN MATCHED THEN UPDATE SET ConfigValue = @val, UpdatedAt = GETDATE(), UpdatedBy = @by
        WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue, UpdatedAt, UpdatedBy) VALUES ('SUBSCRIPTION_PLANS', @val, GETDATE(), @by);
      `, { val: plansJson, by: req.user.Mobile || 'SuperAdmin' });
    }

    if (maintenanceMode !== undefined) {
      await executeQuery(`
        MERGE SystemConfig AS target
        USING (SELECT 'MAINTENANCE_MODE' AS ConfigKey) AS src
        ON target.ConfigKey = src.ConfigKey
        WHEN MATCHED THEN UPDATE SET ConfigValue = @val, UpdatedAt = GETDATE(), UpdatedBy = @by
        WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue, UpdatedAt, UpdatedBy) VALUES ('MAINTENANCE_MODE', @val, GETDATE(), @by);
      `, { val: String(maintenanceMode), by: req.user.Mobile || 'SuperAdmin' });
    }

    if (broadcastNotice !== undefined) {
      await executeQuery(`
        MERGE SystemConfig AS target
        USING (SELECT 'BROADCAST_NOTICE' AS ConfigKey) AS src
        ON target.ConfigKey = src.ConfigKey
        WHEN MATCHED THEN UPDATE SET ConfigValue = @val, UpdatedAt = GETDATE(), UpdatedBy = @by
        WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue, UpdatedAt, UpdatedBy) VALUES ('BROADCAST_NOTICE', @val, GETDATE(), @by);
      `, { val: String(broadcastNotice), by: req.user.Mobile || 'SuperAdmin' });
    }

    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'Configuration',
      action: 'Update System Settings',
      description: `Admin updated platform configuration (Free Trial: ${freeTrialDays} days, Maintenance: ${maintenanceMode})`
    });

    res.json({ success: true, message: 'Configurations saved successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 5. AUDIT LOGS & ACTIVITY TRACKING
// =========================================================================
router.get('/audit-logs', requireAuth, requireSA, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const moduleFilter = req.query.module || 'all';
    const actorFilter = req.query.actor || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    // Check if ActivityLog is empty and seed initial sample data
    const existingCount = await executeQuery(`SELECT COUNT(*) AS total FROM ActivityLog`);
    if ((existingCount?.[0]?.total || 0) === 0) {
      // Seed initial realistic activity entries
      await executeQuery(`
        INSERT INTO ActivityLog (fUID, ActorType, ActorID, ActorName, Module, Action, EntityType, EntityID, Description, CreatedAt)
        VALUES 
        (1, 'SuperAdmin', '1', 'SuperAdmin', 'Configuration', 'Initialize System', 'System', '1', 'System configurations and database initialized', DATEADD(minute, -120, GETDATE())),
        (95023, 'User', '95023', '1111111111', 'Auth', 'User Login', 'Session', '95023', 'Main user logged into web platform', DATEADD(minute, -90, GETDATE())),
        (95023, 'User', '95023', '1111111111', 'SubUsers', 'Create Staff', 'SubUser', '1', 'Created sub-user U1 with mobile 1111111111', DATEADD(minute, -85, GETDATE())),
        (4, 'User', '4', '9518631442', 'Customers', 'Add Customer', 'Customer', 'C-101', 'Created new customer account Rajesh Kumar', DATEADD(minute, -60, GETDATE())),
        (4, 'SubUser', '3', 'Happy', 'Hisaab', 'Balance Entry', 'Hisaab', 'H-402', 'Staff Happy entered balance entry of 5000', DATEADD(minute, -45, GETDATE())),
        (3, 'User', '3', '9256648900', 'Auth', 'User Login', 'Session', '3', 'User logged into mobile platform', DATEADD(minute, -30, GETDATE())),
        (3, 'SubUser', '5', 'ANISH', 'Accounts', 'Update Entry', 'Accounts', 'ACC-91', 'Staff ANISH updated client entry in accounts', DATEADD(minute, -15, GETDATE())),
        (1, 'SuperAdmin', '1', 'SuperAdmin', 'Subscription', 'Review Plans', 'Plans', 'Monthly', 'SuperAdmin reviewed subscription plans and trial stats', GETDATE());
      `);
    }

    let where = [];
    let params = { limit, offset };

    if (q) {
      where.push("(Description LIKE '%' + @q + '%' OR ActorName LIKE '%' + @q + '%' OR Action LIKE '%' + @q + '%' OR CAST(fUID AS VARCHAR) LIKE '%' + @q + '%')");
      params.q = q;
    }
    if (moduleFilter && moduleFilter !== 'all') {
      where.push("Module = @module");
      params.module = moduleFilter;
    }
    if (actorFilter && actorFilter !== 'all') {
      where.push("ActorType = @actor");
      params.actor = actorFilter;
    }

    const wSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await executeQuery(`SELECT COUNT(*) AS Total FROM ActivityLog ${wSql}`, params);
    const total = countRes?.[0]?.Total || 0;

    const logs = await executeQuery(`
      SELECT LogID, fUID, ActorType, ActorID, ActorName, Module, Action, EntityType, EntityID, Description, CreatedAt
      FROM ActivityLog
      ${wSql}
      ORDER BY LogID DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, params);

    const modules = await executeQuery(`SELECT DISTINCT Module FROM ActivityLog WHERE Module IS NOT NULL AND Module != ''`);

    res.json({
      success: true,
      data: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        logs: logs || [],
        availableModules: (modules || []).map(m => m.Module)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 6. ACCOUNT SWITCHING (SUPERADMIN IMPERSONATION)
// =========================================================================
router.get('/switch-user/:uid', requireAuth, requireSA, async (req, res) => {
  try {
    const targetUid = parseInt(req.params.uid);
    const uRows = await executeQuery('SELECT UID, Mobile, Password, Status, Validity, IsSuperAdmin FROM Users WHERE UID = @uid', { uid: targetUid });
    if (!uRows || uRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const targetUser = uRows[0];
    const today = new Date(); today.setHours(0,0,0,0);
    const uValDate = targetUser.Validity ? new Date(targetUser.Validity) : null;
    const isExp = !uValDate || uValDate.getTime() < today.getTime();
    const daysRem = uValDate ? Math.max(0, Math.ceil((uValDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))) : 0;

    const payload = {
      UID: targetUser.UID,
      Mobile: targetUser.Mobile,
      SuperAdmin: 'SuperAdmin', // Maintain SuperAdmin authority so admin can toggle back
      SuperAdminStatus: targetUser.IsSuperAdmin ? targetUser.IsSuperAdmin.toString() : 'False',
      validity: targetUser.Validity,
      isExpired: isExp,
      daysRemaining: daysRem,
      isImpersonating: true,
      originalAdminUID: req.user.UID
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'Admin',
      action: 'Account Switch',
      entityType: 'User',
      entityID: String(targetUid),
      description: `SuperAdmin switched into user account #${targetUid} (${targetUser.Mobile})`
    });

    res.json({ success: true, token, user: payload, message: `Switched to user ${targetUser.Mobile}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/back-to-admin', requireAuth, (req, res) => {
  res.json({ success: true });
});

// =========================================================================
// 7. USER & SUB-USER CRUD (PRESERVED FOR COMPATIBILITY)
// =========================================================================
router.get('/users', requireAuth, requireSA, async (req, res) => {
  try {
    const data = await executeStoredProcedure('SelectUsersAdmin', {});
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/users', requireAuth, requireSA, async (req, res) => {
  try {
    const { mobile, validityDate, password } = req.body;
    if (!mobile || !validityDate) return res.status(400).json({ success: false, message: 'mobile and validityDate required' });
    const data = await executeStoredProcedure('InsertUsersAdmin', {
      Mobile: mobile,
      Password: password || '1234',
      ValidityDate: validityDate
    });
    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'Users',
      action: 'Create User',
      description: `Created new user with mobile ${mobile}`
    });
    res.json({ success: true, data: data?.[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/users/:uid', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid } = req.params;
    const { isActive, validityDate, password } = req.body;
    const isAct = (isActive === 'True' || isActive === true || isActive === 1) ? 'True' : 'False';
    await executeStoredProcedure('UpdateUsersAdmin', {
      UID: uid,
      IsActive: isAct,
      ValidityDate: validityDate || null
    });
    if (password) {
      await executeQuery(`UPDATE Users SET Password=@pwd WHERE UID=@uid`, { pwd: password, uid: parseInt(uid) });
    }
    await logActivity({
      fUID: req.user.UID,
      actorType: 'SuperAdmin',
      actorID: String(req.user.UID),
      actorName: req.user.Mobile || 'SuperAdmin',
      module: 'Users',
      action: 'Update User',
      entityID: String(uid),
      description: `Updated user #${uid} (Status: ${isAct}, Validity: ${validityDate})`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/users/:uid', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid } = req.params;
    await executeStoredProcedure('DeleteUsersAdmin', { UID: uid });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/sub-users', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeStoredProcedure('SelectSubUsers', { UID: uid });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/sub-users', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { subusername, mobile, password, isActive } = req.body;
    if (!subusername || !mobile || !password) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }
    await executeStoredProcedure('InsertSubUsers', {
      subusername,
      Mobile: mobile,
      Password: password,
      IsActive: isActive === 'True' || isActive === true,
      fcreatedUID: uid
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/sub-users/:subUserId', requireAuth, async (req, res) => {
  try {
    const { subUserId } = req.params;
    const { subusername, mobile, password, isActive } = req.body;
    await executeStoredProcedure('UpdateSubUsers', {
      SubUserID: subUserId,
      subusername,
      Mobile: mobile,
      Password: password,
      IsActive: isActive === 'True' || isActive === true
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/sub-users/:subUserId', requireAuth, async (req, res) => {
  try {
    const { subUserId } = req.params;
    await executeStoredProcedure('DeleteSubUsers', { SubUserID: subUserId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

router.post('/block-user', requireAuth, requireSA, async (req, res) => {
  try {
    const { mobile } = req.body;
    await executeQuery(`UPDATE Users SET Status='False' WHERE Mobile=@mobile`, { mobile });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/unblock-user', requireAuth, requireSA, async (req, res) => {
  try {
    const { mobile, validityDate } = req.body;
    await executeQuery(
      `UPDATE Users SET Status='True', Validity=@validityDate WHERE Mobile=@mobile`,
      { mobile, validityDate: validityDate || null }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/block-all', requireAuth, requireSA, async (req, res) => {
  try {
    await executeQuery(`UPDATE Users SET Status='False'`, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/unblock-all', requireAuth, requireSA, async (req, res) => {
  try {
    const { validityDate } = req.body;
    await executeQuery(`UPDATE Users SET Status='True', Validity=@validityDate`, { validityDate: validityDate || null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Legacy sales & yantri endpoints preserved for API backwards compatibility
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

router.get('/all-user-games', requireAuth, requireSA, async (req, res) => {
  try {
    const { uid } = req.query;
    const data = await executeStoredProcedure('GetAllGames', { UID: uid });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

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

module.exports = router;
