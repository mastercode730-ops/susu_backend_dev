const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { getAssignedClients } = require('../utils/assignedClients');

function getIST() { return new Date(Date.now() + 5.5 * 60 * 60 * 1000); }

function toSqlDate(dateStr) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!dateStr) {
    const ist = getIST();
    return String(ist.getUTCDate()).padStart(2,'0') + '/' + MONTHS[ist.getUTCMonth()] + '/' + ist.getUTCFullYear();
  }
  const s = String(dateStr).trim();
  const ddmmyyyy = s.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/);
  if (ddmmyyyy) return ddmmyyyy[1].padStart(2, '0') + '/' + ddmmyyyy[2] + '/' + ddmmyyyy[3];
  const ddmmNumeric = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmNumeric) {
    const moIdx = parseInt(ddmmNumeric[2], 10) - 1;
    const moStr = (moIdx >= 0 && moIdx < 12) ? MONTHS[moIdx] : MONTHS[0];
    return ddmmNumeric[1].padStart(2, '0') + '/' + moStr + '/' + ddmmNumeric[3];
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[3] + '/' + MONTHS[parseInt(iso[2])-1] + '/' + iso[1];
  const ist = getIST();
  return String(ist.getUTCDate()).padStart(2,'0') + '/' + MONTHS[ist.getUTCMonth()] + '/' + ist.getUTCFullYear();
}

// GET /api/accounts/latest-date
router.get('/latest-date', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rows = await executeQuery(
      `SELECT MAX(d) AS MsgDate FROM (
         SELECT MAX(Date) AS d FROM Accounts
         WHERE CreatedBy=@uid
           AND CAST(Date AS date) <= CAST(DATEADD(minute, 330, GETUTCDATE()) AS date)
         UNION ALL
         SELECT MAX(MsgDate) AS d FROM Chat
         WHERE (fReceiverID=@uid OR fSenderID=@uid)
           AND CAST(MsgDate AS date) <= CAST(DATEADD(minute, 330, GETUTCDATE()) AS date)
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
  } catch (err) {
    const ist = getIST();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dd = String(ist.getUTCDate()).padStart(2, '0');
    const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const mon = MONTHS[ist.getUTCMonth()];
    const yyyy = ist.getUTCFullYear();
    res.json({ success: true, date: `${dd}/${mon}/${yyyy}`, dmy: `${dd}/${mm}/${yyyy}`, data: `${dd}/${mm}/${yyyy}`, iso: `${yyyy}-${mm}-${dd}` });
  }
});

// GET /api/accounts/customers
router.get('/customers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subUID = req.user.SubUID || null;
    if (subUID && String(subUID) !== '121') {
      const assigned = await getAssignedClients(uid, subUID);
      if (!assigned || assigned.rows.length === 0) {
        return res.json({ success: true, data: [] });
      }
      const qry = `SELECT Customers.CustomerName + ' ' + RIGHT(Customers.Mobile, 5) AS Name, Users.UID
                   FROM Customers
                   INNER JOIN Users ON Customers.Mobile = Users.Mobile
                   INNER JOIN AssignClientToStaff ON Customers.CID = AssignClientToStaff.fCustID
                     AND AssignClientToStaff.fStaffID = @subUID
                     AND (AssignClientToStaff.IsAssigned = 'True' OR AssignClientToStaff.IsAssigned = 1)
                   WHERE Customers.fUID = @uid
                   ORDER BY Customers.CustomerName ASC`;
      const data = await executeQuery(qry, { uid, subUID });
      return res.json({ success: true, data: data || [] });
    }

    const qry = `SELECT Customers.CustomerName + ' ' + RIGHT(Customers.Mobile, 5) AS Name, Users.UID
                 FROM Customers INNER JOIN Users ON Customers.Mobile = Users.Mobile
                 WHERE Customers.fUID = @uid
                 ORDER BY Customers.CustomerName ASC`;
    const data = await executeQuery(qry, { uid });
    res.json({ success: true, data: data || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/accounts/subusers
router.get('/subusers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeQuery(
      `SELECT SubUserID, subusername, IsActive FROM subusers WHERE fcreatedUID = @uid AND (IsActive = 1 OR IsActive = 'True')`,
      { uid }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/accounts/list
router.get('/list', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const subUID = req.user.SubUID || null;
    const fromDate = req.query.fromDate || req.query.fDate || '';
    const toDate = req.query.toDate || req.query.tDate || '';
    const rawStaff = req.query.staffUID !== undefined ? req.query.staffUID : req.query.staffID;
    const rawCust = req.query.custUID !== undefined ? req.query.custUID : req.query.customerUID;

    const params = { fUID: uid, FDate: fromDate, TDate: toDate };
    if (rawStaff !== undefined && rawStaff !== '' && rawStaff !== 'All' && rawStaff !== 'all') {
      params.fStaff = (rawStaff === 'Self' || rawStaff === '0') ? 0 : rawStaff;
    }
    if (rawCust !== undefined && rawCust !== '' && rawCust !== 'All' && rawCust !== 'all') {
      params.fCID = (rawCust === 'Self' || rawCust === '0') ? 0 : rawCust;
    }
    let data = await executeStoredProcedure('ShowAllTransaction', params);

    // If subuser (except 121 who has all access), filter to ONLY assigned customers
    if (subUID && String(subUID) !== '121') {
      const assigned = await getAssignedClients(uid, subUID);
      if (!assigned || assigned.rows.length === 0) {
        return res.json({ success: true, data: [] });
      }
      data = (data || []).filter(r => {
        const custUID = String(r.fCustID || '');
        const mob = String(r.Mobile || '').replace(/\D/g, '');
        return (custUID && assigned.uids.has(custUID)) || (mob && assigned.mobiles.has(mob));
      });
    }

    res.json({ success: true, data: data || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/accounts/selected-balance
router.get('/selected-balance', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { customerUID } = req.query;
    const data = await executeStoredProcedure('SelectedUserBalance', { fUID: uid, UID: customerUID });
    const balance = data && data[0] ? (data[0].WinAmount || data[0].balance || 0) : 0;
    res.json({ success: true, balance });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/accounts (Create Transaction)
router.post('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    // Support both customerUID (mobile app) and cusID (old format)
    const customerUID = req.body.customerUID || req.body.cusID;
    const { date, type, amount, narration, staffID } = req.body;
    if (!amount || !type) return res.status(400).json({ success: false, message: 'Amount and Type required' });
    const typeMap = {
      'Payment/Diye': 'Paid',
      'Receipt/Liye': 'Received',
      'AdjustReceipt(-)': 'Receive Adjustment',
      'AdjustPayment(+)': 'Paid Adjustment'
    };
    const finalType = typeMap[type] || type;
    await executeStoredProcedure('CreateTransaction', {
      fCusID: customerUID === 'Self' ? 0 : customerUID,
      date: toSqlDate(date), Type: finalType, Amount: amount,
      CreatedBy: uid, Narration: narration || '',
      fStaff: (finalType === 'Paid' || finalType === 'Received') && staffID ? staffID : 0
    });
    res.json({ success: true, message: 'Transaction created' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Narration column is only Varchar(50) (confirmed from CreateTransaction SP
// text) — leave room for the `~tx<AID>` pairing tag we append so a Transfer's
// two entries can be found and deleted together.
function buildNarration(userNote, label, pairedAid) {
  const tag = ` ~tx${pairedAid != null ? pairedAid : '0'}`;
  const prefix = (userNote && userNote.trim()) ? userNote.trim() : label;
  return (prefix.slice(0, 50 - tag.length) + tag).slice(0, 50);
}

// POST /api/accounts/transfer — customer-to-customer settlement in one action:
// "Received" from customer A + "Paid" to customer B, same amount/date.
// (Mirror of the website backend's /api/accounts/transfer.) The two entries
// are cross-linked via a `~tx<AID>` tag in Narration (CreateTransaction has
// no OUTPUT/identity return, so this is how the paired row gets found again
// for one-click delete-both).
router.post('/transfer', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { fromUID, toUID, date, amount, narration, staffID, fromName, toName } = req.body;

    if (!fromUID || !toUID) return res.status(400).json({ success: false, message: 'Both customers required' });
    if (String(fromUID) === String(toUID)) return res.status(400).json({ success: false, message: 'From and To customer must be different' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    const fStaff = staffID && staffID !== '0' ? staffID : 0;
    const label1 = `Transfer To ${toName || toUID}`;
    const label2 = `Transfer From ${fromName || fromUID}`;
    const sqlDate = toSqlDate(date);

    // Entry 1: Received from A — placeholder tag (~tx0) until we know entry 2's AID
    await executeStoredProcedure('CreateTransaction', {
      fCusID: fromUID, date: sqlDate, Type: 'Received', Amount: amount,
      CreatedBy: uid, Narration: buildNarration(narration, label1, 0), fStaff
    });
    const row1 = await executeQuery(
      `SELECT TOP 1 AID FROM Accounts WHERE CreatedBy=@uid AND fCustID=@fromUID AND [Date]=@date
       AND EntryType='Received' AND Received=@amount ORDER BY AID DESC`,
      { uid, fromUID, date: sqlDate, amount }
    );
    const aid1 = row1?.[0]?.AID;

    // Entry 2: Paid to B — tagged with entry 1's real AID.
    // Not wrapped in a DB transaction (SP-per-call API) — if this second
    // insert fails, surface it loudly so the lone Received entry gets
    // corrected manually from the Accounts list.
    let aid2;
    try {
      await executeStoredProcedure('CreateTransaction', {
        fCusID: toUID, date: sqlDate, Type: 'Paid', Amount: amount,
        CreatedBy: uid, Narration: buildNarration(narration, label2, aid1), fStaff
      });
      const row2 = await executeQuery(
        `SELECT TOP 1 AID FROM Accounts WHERE CreatedBy=@uid AND fCustID=@toUID AND [Date]=@date
         AND EntryType='Paid' AND Paid=@amount ORDER BY AID DESC`,
        { uid, toUID, date: sqlDate, amount }
      );
      aid2 = row2?.[0]?.AID;
    } catch (err2) {
      console.error('accounts/transfer: Paid leg failed after Received leg saved:', err2);
      return res.status(500).json({
        success: false,
        message: 'Received entry saved but Paid entry FAILED — delete the Received entry from the list and retry'
      });
    }

    // Patch entry 1's tag now that entry 2's real AID is known (best-effort).
    if (aid1 && aid2) {
      try {
        await executeQuery(
          `UPDATE Accounts SET Narration=@n WHERE AID=@aid1`,
          { n: buildNarration(narration, label1, aid2), aid1 }
        );
      } catch (err3) { console.error('accounts/transfer: pair-tag patch failed (non-fatal):', err3); }
    }

    res.json({ success: true, message: 'Transfer saved' });
  } catch (err) {
    console.error('accounts/transfer:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/accounts/:aid
router.delete('/:aid', requireAuth, async (req, res) => {
  try {
    const aid = parseInt(req.params.aid);
    const uid = req.user ? req.user.UID : (req.session?.user?.UID);
    await executeStoredProcedure('DeleteTransaction', { AID: aid, CreatedBy: uid });
    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /api/accounts/:aid (and POST /api/accounts/update/:aid)
async function handleUpdateTx(req, res) {
  try {
    const aid = parseInt(req.params.aid);
    const uid = req.user ? req.user.UID : (req.session?.user?.UID);
    const customerUID = req.body.customerUID !== undefined ? req.body.customerUID : req.body.cusID;
    const { date, type, amount, narration, staffID } = req.body;
    if (!amount || !type) return res.status(400).json({ success: false, message: 'Amount and Type required' });
    const typeMap = {
      'Payment/Diye': 'Paid',
      'Receipt/Liye': 'Received',
      'AdjustReceipt(-)': 'Receive Adjustment',
      'AdjustPayment(+)': 'Paid Adjustment'
    };
    const finalType = typeMap[type] || type;
    const fStaff = (finalType === 'Paid' || finalType === 'Received') && staffID ? parseInt(staffID) : 0;
    const fCusID = (customerUID === 'Self' || customerUID === '0' || customerUID === 0) ? 0 : parseInt(customerUID);

    await executeStoredProcedure('UpdateTransaction', {
      AID: aid,
      fCusID,
      date: toSqlDate(date),
      Type: finalType,
      Amount: parseFloat(amount),
      CreatedBy: uid,
      Narration: narration || '',
      fStaff
    });
    res.json({ success: true, message: 'Transaction updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

router.put('/:aid', requireAuth, handleUpdateTx);
router.post('/update/:aid', requireAuth, handleUpdateTx);
router.post('/:aid', requireAuth, handleUpdateTx);

module.exports = router;
