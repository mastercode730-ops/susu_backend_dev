const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { getAssignedClients } = require('../utils/assignedClients');

function toSqlDate(dateStr) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (!dateStr) return '';
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
  if (iso) return iso[3] + '/' + MONTHS[parseInt(iso[2], 10)-1] + '/' + iso[1];
  return s;
}

router.get('/games', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const games = await executeStoredProcedure('FetchGames', { fId: uid });

    const pendingRows = await executeQuery(
      `SELECT DISTINCT fGameID, fSenderID FROM Chat WHERE fReceiverID=@uid AND IsAccepted='Pending'`,
      { uid }
    );
    const pendingMap = {};
    for (const row of (pendingRows || [])) {
      if (!pendingMap[row.fGameID]) pendingMap[row.fGameID] = new Set();
      pendingMap[row.fGameID].add(row.fSenderID);
    }
    const result = (games || []).map(g => ({
      ...g,
      UnreadCount: pendingMap[g.GID] ? pendingMap[g.GID].size : 0
    }));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/receivers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const filter = (req.query.filter || '').trim();
    // Dashboard customer search: MUST NOT depend on AssignClientToStaff module.
    // All customers across all accounts appear so anyone can search and make entries.
    const query = `
      SELECT DISTINCT
        u.UID,
        c.CustomerName,
        c.CID,
        c.Mobile,
        CAST(ISNULL(c.D_PComm, 0) AS int) AS D_PComm,
        CAST(ISNULL(c.D_Amt, 100) AS int) AS D_Amt,
        CAST(ISNULL(c.A_PComm, 0) AS int) AS A_PComm,
        CAST(ISNULL(c.A_Amt, 10) AS int) AS A_Amt,
        CAST(ISNULL(c.Patti, 0) AS int) AS Patti,
        c.LC,
        c.IsSelfComm,
        ISNULL(
          CAST(CAST(c.D_PComm AS float) AS varchar) + '/' + CAST(CAST(c.D_Amt AS float) AS varchar) + '-' +
          CAST(CAST(c.A_PComm AS float) AS varchar) + '/' + CAST(CAST(c.A_Amt AS float) AS varchar) + '-' +
          CAST(CAST(c.Patti AS float) AS varchar),
          '0/100-0/10-0'
        ) AS Rate
      FROM Customers c
      LEFT JOIN Users u ON c.Mobile = u.Mobile
      WHERE c.fUID = @uid
        ${filter ? "AND (c.CustomerName LIKE '%' + @filter + '%' OR c.Mobile LIKE '%' + @filter + '%')" : ""}
      ORDER BY c.CustomerName ASC
    `;
    const data = await executeQuery(query, { uid: String(uid), filter });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/messages', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const mobile = req.user.Mobile;
    const filter = (req.query.filter || '').trim();

    let data = await executeStoredProcedure('GetMySendMessage', {
      fSenderID: mobile || uid,
      Filter: filter
    });

    if (!data || data.length === 0) {
      data = await executeStoredProcedure('FetchReceiverList', {
        fUID: String(uid),
        Filter: filter
      });
    }

    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/dashboard-stats', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const today = ist.toISOString().split('T')[0];
    const [games, customers, todayMessages] = await Promise.all([
      executeQuery(`SELECT COUNT(*) AS cnt FROM Game WHERE fUID=@uid AND IsActive='True'`, { uid }),
      executeQuery(`SELECT COUNT(*) AS cnt FROM Customers WHERE fUID=@uid`, { uid }),
      executeQuery(`SELECT COUNT(*) AS cnt FROM Chat WHERE fSenderID=@uid AND CAST(MsgDate AS date)=@today`, { uid, today })
    ]);
    res.json({ success: true, data: { totalGames: games?.[0]?.cnt || 0, totalCustomers: customers?.[0]?.cnt || 0, todayMessages: todayMessages?.[0]?.cnt || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/absent-customers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { gameID, date } = req.query;
    const data = await executeStoredProcedure('CheckAbsentCustomers', { UID: uid, GameID: gameID, MsgDate: toSqlDate(date) || date });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/user-by-mobile/:mobile — receiver UID lookup
router.get('/user-by-mobile/:mobile', requireAuth, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT UID, Mobile FROM Users WHERE Mobile = @mobile`,
      { mobile: req.params.mobile }
    );
    if (!rows || rows.length === 0) return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/archive', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { fromDate, toDate } = req.body;
    await executeStoredProcedure('InsertSettledChat', { fUID: uid, FromDate: fromDate, ToDate: toDate });
    res.json({ success: true, message: 'Archive successful' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/receiver-list?filter=
router.get('/receiver-list', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const filter = (req.query.filter || '').trim();
    // Dashboard customer list: MUST NOT depend on AssignClientToStaff module.
    // All customers across all accounts appear so anyone can make entries.
    const query = `
      SELECT DISTINCT
        u.UID,
        c.CustomerName,
        c.CID,
        c.Mobile,
        CAST(ISNULL(c.D_PComm, 0) AS int) AS D_PComm,
        CAST(ISNULL(c.D_Amt, 100) AS int) AS D_Amt,
        CAST(ISNULL(c.A_PComm, 0) AS int) AS A_PComm,
        CAST(ISNULL(c.A_Amt, 10) AS int) AS A_Amt,
        CAST(ISNULL(c.Patti, 0) AS int) AS Patti,
        c.LC,
        c.IsSelfComm,
        ISNULL(
          CAST(CAST(c.D_PComm AS float) AS varchar) + '/' + CAST(CAST(c.D_Amt AS float) AS varchar) + '-' +
          CAST(CAST(c.A_PComm AS float) AS varchar) + '/' + CAST(CAST(c.A_Amt AS float) AS varchar) + '-' +
          CAST(CAST(c.Patti AS float) AS varchar),
          '0/100-0/10-0'
        ) AS Rate
      FROM Customers c
      LEFT JOIN Users u ON c.Mobile = u.Mobile
      WHERE c.fUID = @uid
        ${filter ? "AND (c.CustomerName LIKE '%' + @filter + '%' OR c.Mobile LIKE '%' + @filter + '%')" : ""}
      ORDER BY c.CustomerName ASC
    `;
    const data = await executeQuery(query, { uid: String(uid), filter });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/user-games/:uid
router.get('/user-games/:uid', requireAuth, async (req, res) => {
  try {
    const data = await executeStoredProcedure('FetchGames', { fId: req.params.uid });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/customer-rates/:cid
router.get('/customer-rates/:cid', requireAuth, async (req, res) => {
  try {
    let data = await executeQuery(
      `SELECT ISNULL(CAST(CAST(CustomersRates.D_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.D_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.A_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.A_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.Patti AS float) AS varchar), '0/100-0/10-0') AS Rate,
        CustomersRates.fUID, CustomersRates.RateID, CustomersRates.MobileNo,
        CustomersRates.D_PComm, CustomersRates.D_Amt, CustomersRates.A_PComm,
        CustomersRates.A_Amt, CustomersRates.Patti,
        ISNULL(Customers.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
        ISNULL(Customers.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
        ISNULL(Customers.ThirdPartyCommID, 0) AS ThirdPartyCommID,
        ISNULL(Customers.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
        ISNULL(Customers.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm
       FROM CustomersRates
       INNER JOIN Customers ON CustomersRates.CID = Customers.CID
       WHERE CustomersRates.CID = @cid`,
      { cid: req.params.cid }
    );
    if (!data || data.length === 0) {
      data = await executeQuery(
        `SELECT '0/100-0/10-0' AS Rate,
          C.fUID, 0 AS RateID, C.Mobile AS MobileNo,
          C.D_PComm, C.D_Amt, C.A_PComm, C.A_Amt, C.Patti,
          ISNULL(C.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
          ISNULL(C.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
          ISNULL(C.ThirdPartyCommID, 0) AS ThirdPartyCommID,
          ISNULL(C.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
          ISNULL(C.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm
         FROM Customers C
         WHERE C.CID = @cid`,
        { cid: req.params.cid }
      );
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/all-games
router.get('/all-games', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeStoredProcedure('GetAllGames', { UID: String(uid), IsActive: 'True' });
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/bulk-customers
router.get('/bulk-customers', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeQuery(
      `SELECT CID, CustomerName, Mobile, (SELECT UID FROM Users WHERE Mobile = Customers.Mobile) AS UID
       FROM Customers WHERE fUID = @fUID`,
      { fUID: uid }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/bulk-rates/:cid
router.get('/bulk-rates/:cid', requireAuth, async (req, res) => {
  try {
    const data = await executeQuery(
      `SELECT ISNULL(CAST(CAST(CustomersRates.D_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.D_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.A_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.A_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.Patti AS float) AS varchar), '0/100-0/10-0') AS Rate,
        CustomersRates.fUID, CustomersRates.RateID, CustomersRates.MobileNo,
        CustomersRates.D_PComm, CustomersRates.D_Amt, CustomersRates.A_PComm,
        CustomersRates.A_Amt, CustomersRates.Patti,
        ISNULL(Customers.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
        ISNULL(Customers.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer
       FROM CustomersRates
       INNER JOIN Customers ON CustomersRates.CID = Customers.CID
       WHERE CustomersRates.CID = @cid`,
      { cid: req.params.cid }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/home/bulk-rate-by-id/:rateID
router.get('/bulk-rate-by-id/:rateID', requireAuth, async (req, res) => {
  try {
    const data = await executeQuery(
      `SELECT (SELECT UID FROM Users WHERE Mobile = CustomersRates.MobileNo) AS UID,
        ISNULL(CAST(CAST(CustomersRates.D_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.D_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.A_PComm AS float) AS varchar) + '/' +
        CAST(CAST(CustomersRates.A_Amt AS float) AS varchar) + '-' +
        CAST(CAST(CustomersRates.Patti AS float) AS varchar), '0/100-0/10-0') AS Rate,
        CustomersRates.fUID, CustomersRates.RateID, CustomersRates.MobileNo,
        CustomersRates.D_PComm, CustomersRates.D_Amt, CustomersRates.A_PComm,
        CustomersRates.A_Amt, CustomersRates.Patti,
        ISNULL(Customers.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
        ISNULL(Customers.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
        ISNULL(Customers.ThirdPartyCommID, 0) AS ThirdPartyCommID,
        ISNULL(Customers.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
        ISNULL(Customers.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm
       FROM CustomersRates
       INNER JOIN Customers ON CustomersRates.CID = Customers.CID
       WHERE CustomersRates.RateID = @rateID`,
      { rateID: req.params.rateID }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
