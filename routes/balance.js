const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { getAssignedClients } = require('../utils/assignedClients');

const { toSqlDate } = require('../utils/dateHelper');


// GET /api/balance/latest-date
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

// GET /api/balance/my-balance
router.get('/my-balance', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const mobile = req.user.Mobile || '';
    const { date } = req.query;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('GetMYBalance', {
      fUID: uid, Date: toSqlDate(date), Filter: '', Mobile: mobile
    });
    if (assigned && data) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/game-balance
router.get('/game-balance', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { date } = req.query;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('GetMyGameBalance', {
      fUID: uid, Date: toSqlDate(date), Filter: ''
    });
    data = data || [];
    if (assigned) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/uttar-balance
router.get('/uttar-balance', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { date } = req.query;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    let data = await executeStoredProcedure('GetMyGameBalance', {
      fUID: uid, Date: toSqlDate(date), Filter: '', IsUttar: true
    });
    data = data || [];
    if (assigned) {
      data = data.filter(r => assigned.isMatch(r));
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/staff-grid
router.get('/staff-grid', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { date } = req.query;
    const data = await executeStoredProcedure('StaffBalanceSheet', {
      fUID: uid, Date: toSqlDate(date)
    });
    const total = (data || []).reduce((s, r) => s + (parseFloat(r.Balance) || 0), 0);
    res.json({ success: true, data: data || [], totalBalance: total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/staff-balance
router.get('/staff-balance', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subUID = req.query.staffID || req.user.SubUID || null;
    if (!subUID) return res.json({ success: true, balance: 0 });
    const data = await executeStoredProcedure('StaffBalanceSheet', {
      fUID: uid, OPTYPE: 1, FSTAFFID: subUID
    });
    const total = (data || []).reduce((s, r) => s + (parseFloat(r.Balance) || 0), 0);
    const subusername = data?.[0]?.subusername || '';
    res.json({ success: true, balance: total, subusername });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/my-balance-history
router.get('/my-balance-history', requireAuth, async (req, res) => {
  try {
    const { customerUID, type, fromDate, toDate } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    if (assigned && customerUID && !assigned.uids.has(String(customerUID))) {
      return res.json({ success: true, data: [] });
    }
    const data = await executeStoredProcedure('GetMYBalanceHistory', {
      fUID: uid, UID: customerUID,
      FromDate: toSqlDate(fromDate || '01/Jan/2022'),
      ToDate: toSqlDate(toDate)
    });
    let rows = data || [];
    const tLower = (type || '').toLowerCase();
    if (tLower === 'sale') {
      rows = rows.filter(r => {
        const t = (r.Type || '').toLowerCase();
        return ['sale', 'self hissa', 'self comm'].includes(t) || t.includes('adjust');
      });
      let running = 0;
      rows = rows.map((r, idx) => {
        const win = parseFloat(r.WinAmount || 0);
        running += win;
        return {
          ...r,
          SrNo: idx + 1,
          RunningTotal: running,
          Dene: win < 0 ? Math.abs(win) : 0,
          Lene: win > 0 ? win : 0
        };
      });
    } else if (tLower === 'accounts' || tLower === 'account') {
      rows = rows.filter(r => {
        const t = (r.Type || '').toLowerCase();
        return !['sale', 'self hissa', 'self comm', 'opening'].includes(t) && !t.includes('adjust');
      });
      let running = 0;
      rows = rows.map((r, idx) => {
        const win = parseFloat(r.WinAmount || 0);
        running += win;
        return {
          ...r,
          SrNo: idx + 1,
          RunningTotal: running,
          Dene: win < 0 ? Math.abs(win) : 0,
          Lene: win > 0 ? win : 0
        };
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/game-balance-history
router.get('/game-balance-history', requireAuth, async (req, res) => {
  try {
    const { customerUID, type, fromDate, toDate } = req.query;
    const uid = req.user.UID;
    const assigned = await getAssignedClients(uid, req.user.SubUID);
    if (assigned && customerUID && !assigned.uids.has(String(customerUID))) {
      return res.json({ success: true, data: [] });
    }
    const data = await executeStoredProcedure('GetMyGameBalanceHistory', {
      fUID: uid, UID: customerUID,
      FromDate: toSqlDate(fromDate || '01/Jan/2022'),
      ToDate: toSqlDate(toDate)
    });
    let rows = data || [];
    const tLower = (type || '').toLowerCase();
    if (tLower === 'sale') {
      rows = rows.filter(r => {
        const t = (r.Type || '').toLowerCase();
        return ['sale', 'self hissa', 'self comm'].includes(t) || t.includes('adjust');
      });
      let running = 0;
      rows = rows.map((r, idx) => {
        const win = parseFloat(r.WinAmount || 0);
        running += win;
        return {
          ...r,
          SrNo: idx + 1,
          RunningTotal: running,
          Dene: win < 0 ? Math.abs(win) : 0,
          Lene: win > 0 ? win : 0
        };
      });
    } else if (tLower === 'accounts' || tLower === 'account') {
      rows = rows.filter(r => {
        const t = (r.Type || '').toLowerCase();
        return !['sale', 'self hissa', 'self comm', 'opening'].includes(t) && !t.includes('adjust');
      });
      let running = 0;
      rows = rows.map((r, idx) => {
        const win = parseFloat(r.WinAmount || 0);
        running += win;
        return {
          ...r,
          SrNo: idx + 1,
          RunningTotal: running,
          Dene: win < 0 ? Math.abs(win) : 0,
          Lene: win > 0 ? win : 0
        };
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/balance/hisab-summary
router.get('/hisab-summary', requireAuth, async (req, res) => {
  try {
    const { customerUID, date, mode } = req.query;
    const uid = req.user.UID;
    const spName = mode === '1' ? 'GetDateWiseMyHisabHistory' : 'GetDateWiseWinAmountHistory';
    const data = await executeStoredProcedure(spName, {
      fUID: uid, Date: toSqlDate(date), UID: customerUID
    });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/balance/add-transaction
router.post('/add-transaction', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subUID = req.user.SubUID || null;
    const { customerCID, date, type, amount } = req.body;
    await executeStoredProcedure('CreateTransaction', {
      fCusID: customerCID,
      date: toSqlDate(date),
      Type: type,
      Amount: parseFloat(amount) || 0,
      CreatedBy: uid,
      Narration: '',
      fStaff: subUID || 0
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
