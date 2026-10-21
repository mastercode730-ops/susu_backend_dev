const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { getAssignedClients } = require('../utils/assignedClients');

const { toSqlDate } = require('../utils/dateHelper');

// GET /api/hisab/latest-date
router.get('/latest-date', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rows = await executeQuery(
      `SELECT MAX(d) AS MsgDate FROM (
         SELECT MAX(MsgDate) AS d FROM Chat
         WHERE (fReceiverID=@uid OR fSenderID=@uid)
           AND CAST(MsgDate AS date) <= CAST(DATEADD(minute, 330, GETUTCDATE()) AS date)
         UNION ALL
         SELECT MAX(Date) AS d FROM Accounts
         WHERE CreatedBy=@uid
           AND CAST(Date AS date) <= CAST(DATEADD(minute, 330, GETUTCDATE()) AS date)
       ) AS T`,
      { uid }
    );
    let d = rows?.[0]?.MsgDate ? new Date(rows[0].MsgDate) : getIST();
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const mon = MONTHS[d.getUTCMonth()];
    const yyyy = d.getUTCFullYear();
    const dateStr = `${dd}/${mon}/${yyyy}`;
    const dmy = `${dd}/${mm}/${yyyy}`;
    res.json({ success: true, date: dateStr, dmy, data: dmy, iso: `${yyyy}-${mm}-${dd}` });
  } catch (e) {
    const ist = getIST();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dd = String(ist.getUTCDate()).padStart(2, '0');
    const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const mon = MONTHS[ist.getUTCMonth()];
    const yyyy = ist.getUTCFullYear();
    res.json({ success: true, date: `${dd}/${mon}/${yyyy}`, dmy: `${dd}/${mm}/${yyyy}`, data: `${dd}/${mm}/${yyyy}`, iso: `${yyyy}-${mm}-${dd}` });
  }
});

// GET /api/hisab/customers
router.get('/customers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subUID = req.user.SubUID || null;
    let qry = `SELECT CustomerName, Mobile, (SELECT UID FROM Users WHERE Mobile=Customers.Mobile) AS UID
       FROM Customers WHERE fUID=@uid`;
    if (subUID) {
      const assigned = await getAssignedClients(uid, subUID);
      if (assigned) {
        qry = `SELECT c.CustomerName, c.Mobile, (SELECT UID FROM Users WHERE Mobile=c.Mobile) AS UID
         FROM Customers c
         INNER JOIN AssignClientToStaff a ON c.CID = a.fCustID AND a.fStaffID = @subUID AND (a.IsAssigned = 'True' OR a.IsAssigned = 1)
         WHERE c.fUID = @uid`;
      }
    }
    const data = await executeQuery(qry, { uid, subUID });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/game-hisab?date=&filter=
router.get('/game-hisab', requireAuth, async (req, res) => {
  try {
    const { date, filter } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('GetDateWiseMyHisab', {
      fUID: uid, Date: toSqlDate(date), Filter: filter || ''
    });
    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/win-amount?date=&filter=
router.get('/win-amount', requireAuth, async (req, res) => {
  try {
    const { date, filter } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('GetDateWiseWinAmount', {
      fUID: uid, Date: toSqlDate(date), Filter: filter || ''
    });
    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/game-hisab-history?date=&uid= (or customerUID=&fromDate=&toDate=)
router.get('/game-hisab-history', requireAuth, async (req, res) => {
  try {
    const { date, uid: custUID, customerUID, fromDate, toDate } = req.query;
    const myUID = req.user.UID;
    const targetUID = custUID || customerUID;
    const assigned = await getAssignedClients(myUID, req.user.SubUID);
    if (assigned && targetUID && !assigned.uids.has(String(targetUID))) {
      return res.json({ success: true, data: [] });
    }
    const data = await executeStoredProcedure('GetDateWiseMyHisabHistory', {
      fUID: myUID,
      Date: toSqlDate(date || fromDate),
      UID: targetUID
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/win-amount-history?date=&uid= (or customerUID=&fromDate=&toDate=)
router.get('/win-amount-history', requireAuth, async (req, res) => {
  try {
    const { date, uid: custUID, customerUID, fromDate, toDate } = req.query;
    const myUID = req.user.UID;
    const targetUID = custUID || customerUID;
    const assigned = await getAssignedClients(myUID, req.user.SubUID);
    if (assigned && targetUID && !assigned.uids.has(String(targetUID))) {
      return res.json({ success: true, data: [] });
    }
    const data = await executeStoredProcedure('GetDateWiseWinAmountHistory', {
      fUID: myUID,
      date: toSqlDate(date || fromDate),
      UID: targetUID
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/sale-history?date=&filter=
router.get('/sale-history', requireAuth, async (req, res) => {
  try {
    const { date, filter } = req.query;
    const uid = req.user.UID;
    if (!date) return res.json({ success: true, data: [] });
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('ShowSaleHistory', {
      fUID: uid, Date: toSqlDate(date), Filter: filter || ''
    });
    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/summary?startDate=&endDate=&gid=&cid=
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, gid, cid, date } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    if (assigned && cid && !assigned.uids.has(String(cid))) {
      return res.json({ success: true, data: [] });
    }
    // Support both new (startDate/endDate) and old (date) param styles
    const fromDate = startDate || date;
    const toDate = endDate || date;

    let data = await executeStoredProcedure('GetHisabSummary', {
      date: toSqlDate(fromDate),
      date1: toSqlDate(toDate),
      UID: uid,
      GID: gid || null,
      CID: cid || null
    });

    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('hisab/summary:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/date-wise-summary?fromDate=&toDate=
router.get('/date-wise-summary', requireAuth, async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('ShowDateWiseHisabSummary', {
      UID: uid, FromDate: toSqlDate(fromDate), ToDate: toSqlDate(toDate || fromDate)
    });
    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/date-wise-user?uid=&fromDate=&toDate=
router.get('/date-wise-user', requireAuth, async (req, res) => {
  try {
    const { uid: custUID, fromDate, toDate } = req.query;
    const myUID = req.user.UID;
    const assigned = await getAssignedClients(myUID, req.user.SubUID);
    if (assigned && custUID && !assigned.uids.has(String(custUID)) && !assigned.cids.has(String(custUID))) {
      return res.json({ success: true, data: [] });
    }
    const data = await executeStoredProcedure('ShowDateWiseHisabSummaryUserID', {
      CID: custUID, UID: myUID,
      FromDate: toSqlDate(fromDate), ToDate: toSqlDate(toDate || fromDate)
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/staff-grid
router.get('/staff-grid', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { date, fromDate, toDate } = req.query;
    const data = await executeStoredProcedure('StaffBalanceSheet', {
      fUID: uid, Date: toSqlDate(date || fromDate)
    });
    const total = (data || []).reduce((s, r) => s + (parseFloat(r.Balance) || 0), 0);
    res.json({ success: true, data: data || [], totalBalance: total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/hisab/show-results?startDate=&endDate=
router.get('/show-results', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const uid = req.user.UID;
    if (!startDate) return res.json({ success: true, data: [] });
    const sqlStart = toSqlDate(startDate);
    const sqlEnd = toSqlDate(endDate || startDate);
    const dParts = sqlStart.split('/');
    const M_MAP = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
    let year = parseInt(dParts[2], 10);
    let month = M_MAP[dParts[1]] || parseInt(dParts[1], 10) || 1;
    if (isNaN(year) || isNaN(month)) {
      const sd = new Date(sqlStart);
      year = sd.getFullYear();
      month = sd.getMonth() + 1;
    }
    const days = new Date(year, month, 0).getDate();
    const data = await executeStoredProcedure('ShowResult', {
      Year: year.toString(), Month: month.toString(), Days: days,
      UID: uid, FromDate: sqlStart, ToDate: sqlEnd
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
