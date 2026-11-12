const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { checkLimit } = require('../utils/subscription');
const { executeStoredProcedure, executeQuery } = require('../config/database');

router.get('/list', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const filter = (req.query.filter || '').trim();
    // Return all customers across all accounts so Add Contact page shows all customers in all accounts
    const data = await executeQuery(
      `SELECT c.CID, c.CustomerName, c.Mobile, c.D_PComm, c.D_Amt, c.A_PComm, c.A_Amt, c.Patti, c.LC, c.IsSelfComm, c.fUID, c.IsYantriTo, c.IsLimit, c.IsUttar,
              CAST(CAST(c.D_PComm AS float) AS varchar) + '/' + CAST(CAST(c.D_Amt AS float) AS varchar) + '-' +
              CAST(CAST(c.A_PComm AS float) AS varchar) + '/' + CAST(CAST(c.A_Amt AS float) AS varchar) + '-' +
              CAST(CAST(c.Patti AS float) AS varchar) AS Rate,
              ISNULL(c.ThirdPartyHissaID, '0') AS ThirdPartyHissaID,
              ISNULL((SELECT CustomerName FROM Customers AS ch WHERE ch.CID = c.ThirdPartyHissaID), '') AS ThirdPartyHissaName,
              ISNULL(c.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
              ISNULL(c.ThirdPartyCommID, 0) AS ThirdPartyCommID,
              ISNULL(c.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
              ISNULL(c.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm,
              ISNULL(c.ThirdPartyLCID, 0) AS ThirdPartyLCID,
              ISNULL(c.ThirdPartyLCPer, 0) AS ThirdPartyLCPer,
              ISNULL((SELECT CustomerName FROM Customers AS ch WHERE ch.CID = c.ThirdPartyCommID), '') AS ThirdPartyCommName,
              ISNULL((SELECT CustomerName FROM Customers AS ch WHERE ch.CID = c.ThirdPartyLCID), '') AS ThirdPartyLCName
       FROM Customers c
       WHERE c.fUID = @uid
         ${filter ? "AND (c.CustomerName LIKE '%' + @filter + '%' OR c.Mobile LIKE '%' + @filter + '%')" : ""}
       ORDER BY c.CustomerName ASC`,
      { uid: String(uid), filter }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const filter = (req.query.filter || '').trim();
    const data = await executeQuery(
      `SELECT DISTINCT
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
      ORDER BY c.CustomerName ASC`,
      { uid: String(uid), filter }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const {
      customerName, mobileNo, mobile, city,
      d_PComm, d_Amt, a_PComm, a_Amt, patti, lc,
      isSelfComm, isYantriTo, isLimit, isUttar,
      thirdPartyHissaID, thirdPartyHissaPer,
      thirdPartyCommID, thirdPartyDaraComm, thirdPartyAkharComm,
      thirdPartyLCID, thirdPartyLCPer
    } = req.body;
    const mob = mobileNo || mobile;
    if (!customerName || !mob) return res.status(400).json({ success: false, message: 'Name and mobile required' });
    const limitMsg = await checkLimit(uid, 'customers');
    if (limitMsg) return res.status(403).json({ success: false, code: 'PLAN_LIMIT', message: limitMsg });
    await executeStoredProcedure('CreateCustomers', {
      CustomerName: customerName, Mobile: mob,
      D_PComm: parseFloat(d_PComm) || 0, D_Amt: parseFloat(d_Amt) || 100, A_PComm: parseFloat(a_PComm) || 0, A_Amt: parseFloat(a_Amt) || 10,
      Patti: parseInt(patti) || 0, LC: parseInt(lc) || 0,
      IsSelfComm: isSelfComm ? true : false,
      IsYantriTo: isYantriTo ? true : false,
      fId: uid, CID: 0, UserID: uid, RateID: 0,
      ThirdPartyHissaID: parseInt(thirdPartyHissaID) || 0, ThirdPartyHissaPer: parseFloat(thirdPartyHissaPer) || 0,
      IsLimit: isLimit ? true : false, IsUttar: isUttar ? true : false,
      ThirdPartyCommID: parseInt(thirdPartyCommID) || 0, ThirdPartyDaraComm: parseFloat(thirdPartyDaraComm) || 0,
      ThirdPartyAkharComm: parseFloat(thirdPartyAkharComm) || 0,
      ThirdPartyLCID: parseInt(thirdPartyLCID) || 0, ThirdPartyLCPer: parseFloat(thirdPartyLCPer) || 0
    });

    // If added by a Sub-User, automatically assign the newly created customer to this sub-user
    if (req.user && req.user.SubUID) {
      try {
        const custRows = await executeQuery(
          `SELECT TOP 1 CID FROM Customers WHERE Mobile = @mob AND fUID = @uid ORDER BY CID DESC`,
          { mob, uid }
        );
        if (custRows && custRows[0] && custRows[0].CID) {
          const newCid = custRows[0].CID;
          const exists = await executeQuery(
            `SELECT 1 FROM AssignClientToStaff WHERE fStaffID = @staffID AND fCustID = @cid AND fUID = @uid`,
            { staffID: req.user.SubUID, cid: newCid, uid }
          );
          if (!exists || exists.length === 0) {
            await executeStoredProcedure('AssignClienttoSatff', {
              fStaffID: req.user.SubUID,
              fCustID: newCid,
              fUID: uid
            });
          }
        }
      } catch (assignErr) {
        console.error('Error auto-assigning customer to subuser:', assignErr);
      }
    }

    // SubUser 121 manages on behalf of parent UID 3 — auto-assign newly added customers to 121 as well
    if (String(uid) === '3') {
      try {
        const custRows121 = await executeQuery(
          `SELECT TOP 1 CID FROM Customers WHERE Mobile = @mob AND fUID = @uid ORDER BY CID DESC`,
          { mob, uid }
        );
        if (custRows121 && custRows121[0] && custRows121[0].CID) {
          const newCid121 = custRows121[0].CID;
          const exists121 = await executeQuery(
            `SELECT 1 FROM AssignClientToStaff WHERE fStaffID = 121 AND fCustID = @cid AND fUID = @uid`,
            { cid: newCid121, uid }
          );
          if (!exists121 || exists121.length === 0) {
            await executeStoredProcedure('AssignClienttoSatff', {
              fStaffID: 121,
              fCustID: newCid121,
              fUID: uid
            });
          }
        }
      } catch (e121) {
        console.error('Error auto-assigning customer to subuser 121:', e121);
      }
    }

    res.json({ success: true, message: 'Customer added' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/update', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const {
      cid, customerName, mobileNo, mobile, city,
      d_PComm, d_Amt, a_PComm, a_Amt, patti, lc,
      isSelfComm, isYantriTo, isLimit, isUttar,
      thirdPartyHissaID, thirdPartyHissaPer,
      thirdPartyCommID, thirdPartyDaraComm, thirdPartyAkharComm,
      thirdPartyLCID, thirdPartyLCPer,
      rateID
    } = req.body;
    const mob = (mobileNo || mobile || '').trim();
    if (!cid) return res.status(400).json({ success: false, message: 'CID required' });
    const parsedCID = parseInt(cid);
    const parsedRateID = parseInt(rateID) || 0;
    const parsedD_PComm = (d_PComm !== undefined && d_PComm !== null && !isNaN(d_PComm)) ? parseFloat(d_PComm) : 0;
    const parsedD_Amt = (d_Amt !== undefined && d_Amt !== null && !isNaN(d_Amt)) ? parseFloat(d_Amt) : 100;
    const parsedA_PComm = (a_PComm !== undefined && a_PComm !== null && !isNaN(a_PComm)) ? parseFloat(a_PComm) : 0;
    const parsedA_Amt = (a_Amt !== undefined && a_Amt !== null && !isNaN(a_Amt)) ? parseFloat(a_Amt) : 10;
    const parsedPatti = parseInt(patti) || 0;
    const parsedLC = parseInt(lc) || 0;

    await executeStoredProcedure('UpdateCustomers', {
      CustomerName: customerName, Mobile: mob,
      D_PComm: parsedD_PComm, D_Amt: parsedD_Amt, A_PComm: parsedA_PComm, A_Amt: parsedA_Amt,
      Patti: parsedPatti, LC: parsedLC,
      IsSelfComm: isSelfComm ? true : false,
      IsYantriTo: isYantriTo ? true : false,
      fId: uid, CID: parsedCID, UserID: uid, RateID: parsedRateID,
      ThirdPartyHissaID: parseInt(thirdPartyHissaID) || 0, ThirdPartyHissaPer: parseFloat(thirdPartyHissaPer) || 0,
      IsLimit: isLimit ? true : false, IsUttar: isUttar ? true : false,
      ThirdPartyCommID: parseInt(thirdPartyCommID) || 0, ThirdPartyDaraComm: parseFloat(thirdPartyDaraComm) || 0,
      ThirdPartyAkharComm: parseFloat(thirdPartyAkharComm) || 0,
      ThirdPartyLCID: parseInt(thirdPartyLCID) || 0, ThirdPartyLCPer: parseFloat(thirdPartyLCPer) || 0
    });

    if (mob) {
      await executeQuery(
        `UPDATE Customers
         SET Mobile = @mob,
             D_PComm = @d_PComm,
             D_Amt = @d_Amt,
             A_PComm = @a_PComm,
             A_Amt = @a_Amt,
             Patti = @patti
         WHERE CID = @cid`,
        {
          cid: parsedCID, mob,
          d_PComm: parsedD_PComm, d_Amt: parsedD_Amt,
          a_PComm: parsedA_PComm, a_Amt: parsedA_Amt,
          patti: parsedPatti
        }
      );
    } else {
      await executeQuery(
        `UPDATE Customers
         SET D_PComm = @d_PComm,
             D_Amt = @d_Amt,
             A_PComm = @a_PComm,
             A_Amt = @a_Amt,
             Patti = @patti
         WHERE CID = @cid`,
        {
          cid: parsedCID,
          d_PComm: parsedD_PComm, d_Amt: parsedD_Amt,
          a_PComm: parsedA_PComm, a_Amt: parsedA_Amt,
          patti: parsedPatti
        }
      );
    }

    const existingRates = await executeQuery(
      `SELECT RateID FROM CustomersRates WHERE CID = @cid ORDER BY RateID ASC`,
      { cid: parsedCID }
    );

    if (existingRates && existingRates.length > 0) {
      const targetRateID = (parsedRateID && existingRates.some(r => r.RateID == parsedRateID))
        ? parsedRateID
        : existingRates[0].RateID;

      await executeQuery(
        `UPDATE CustomersRates
         SET D_PComm = @d_PComm,
             D_Amt = @d_Amt,
             A_PComm = @a_PComm,
             A_Amt = @a_Amt,
             Patti = @patti,
             MobileNo = ISNULL(NULLIF(@mob, ''), MobileNo)
         WHERE RateID = @rateID`,
        {
          rateID: targetRateID,
          d_PComm: parsedD_PComm, d_Amt: parsedD_Amt,
          a_PComm: parsedA_PComm, a_Amt: parsedA_Amt,
          patti: parsedPatti,
          mob
        }
      );

      if (mob) {
        await executeQuery(
          `UPDATE CustomersRates SET MobileNo = @mob WHERE CID = @cid`,
          { cid: parsedCID, mob }
        );
      }
    } else {
      await executeQuery(
        `INSERT INTO CustomersRates (CID, fUID, MobileNo, D_PComm, D_Amt, A_PComm, A_Amt, Patti, IsActive)
         VALUES (@cid, @uid, @mob, @d_PComm, @d_Amt, @a_PComm, @a_Amt, @patti, 'True')`,
        {
          cid: parsedCID, uid, mob,
          d_PComm: parsedD_PComm, d_Amt: parsedD_Amt,
          a_PComm: parsedA_PComm, a_Amt: parsedA_Amt,
          patti: parsedPatti
        }
      );
    }

    res.json({ success: true, message: 'Customer updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customer/:cid/rates (mobile app calls this format)
router.get('/:cid/rates', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    let data = await executeQuery(
      `SELECT CR.*,
              ISNULL(C.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
              ISNULL(C.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
              ISNULL(C.ThirdPartyCommID, 0) AS ThirdPartyCommID,
              ISNULL(C.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
              ISNULL(C.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm,
              (SELECT TOP 1 UID FROM Users WHERE Mobile = CR.MobileNo OR REPLACE(Mobile, ' ', '') = REPLACE(CR.MobileNo, ' ', '')) AS fUserUID
       FROM CustomersRates CR 
       LEFT JOIN Customers C ON CR.CID = C.CID
       WHERE CR.CID = @cid`,
      { cid: parseInt(req.params.cid) }
    );
    if (!data || data.length === 0) {
      data = await executeQuery(
        `SELECT 0 AS RateID, C.D_PComm, C.D_Amt, C.A_PComm, C.A_Amt, C.Patti, C.Mobile AS MobileNo,
                C.fUID, C.CID, 'True' AS IsActive,
                ISNULL(C.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
                ISNULL(C.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
                ISNULL(C.ThirdPartyCommID, 0) AS ThirdPartyCommID,
                ISNULL(C.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
                ISNULL(C.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm,
                (SELECT TOP 1 UID FROM Users WHERE Mobile = C.Mobile OR REPLACE(Mobile, ' ', '') = REPLACE(C.Mobile, ' ', '')) AS fUserUID
         FROM Customers C
         WHERE C.CID = @cid`,
        { cid: parseInt(req.params.cid) }
      );
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customer/rates/:cid (alternate format)
router.get('/rates/:cid', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    let data = await executeQuery(
      `SELECT CR.*,
              ISNULL(C.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
              ISNULL(C.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
              ISNULL(C.ThirdPartyCommID, 0) AS ThirdPartyCommID,
              ISNULL(C.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
              ISNULL(C.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm,
              (SELECT TOP 1 UID FROM Users WHERE Mobile = CR.MobileNo OR REPLACE(Mobile, ' ', '') = REPLACE(CR.MobileNo, ' ', '')) AS fUserUID
       FROM CustomersRates CR 
       LEFT JOIN Customers C ON CR.CID = C.CID
       WHERE CR.CID = @cid`,
      { cid: parseInt(req.params.cid) }
    );
    if (!data || data.length === 0) {
      data = await executeQuery(
        `SELECT 0 AS RateID, C.D_PComm, C.D_Amt, C.A_PComm, C.A_Amt, C.Patti, C.Mobile AS MobileNo,
                C.fUID, C.CID, 'True' AS IsActive,
                ISNULL(C.ThirdPartyHissaID, 0) AS ThirdPartyHissaID,
                ISNULL(C.ThirdPartyHissaPer, 0) AS ThirdPartyHissaPer,
                ISNULL(C.ThirdPartyCommID, 0) AS ThirdPartyCommID,
                ISNULL(C.ThirdPartyDaraComm, 0) AS ThirdPartyDaraComm,
                ISNULL(C.ThirdPartyAkharComm, 0) AS ThirdPartyAkharComm,
                (SELECT TOP 1 UID FROM Users WHERE Mobile = C.Mobile OR REPLACE(Mobile, ' ', '') = REPLACE(C.Mobile, ' ', '')) AS fUserUID
         FROM Customers C
         WHERE C.CID = @cid`,
        { cid: parseInt(req.params.cid) }
      );
    }
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:cid', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    await executeQuery(`DELETE FROM Customers WHERE CID=@cid AND fUID=@uid`, { cid: parseInt(req.params.cid), uid });
    res.json({ success: true, message: 'Customer deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customer/delete (mobile app calls this)
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { cid } = req.body;
    await executeQuery(`DELETE FROM Customers WHERE CID=@cid AND fUID=@uid`, { cid: parseInt(cid), uid });
    res.json({ success: true, message: 'Customer deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customer/toggle
router.post('/toggle', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { cid, field, value } = req.body;
    const allowed = ['IsActive', 'IsYantriTo', 'IsUttar'];
    if (!allowed.includes(field)) return res.status(400).json({ success: false, message: 'Invalid field' });
    await executeQuery(
      `UPDATE Customers SET ${field}=@value WHERE CID=@cid AND fUID=@uid`,
      { cid: parseInt(cid), uid, value: value === 'True' ? 'True' : 'False' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/customer/active-status — SuperAdmin-only column on the contacts
// page: for each of the caller's customers that also has its own login
// (Users row matched by Mobile), report whether that login is active.
router.get('/active-status', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const data = await executeQuery(
      `SELECT C.Mobile, U.UID, U.Status AS IsActive
       FROM Customers C
       JOIN Users U ON U.Mobile = C.Mobile
       WHERE C.fUID = @uid`,
      { uid }
    );
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customer/toggle-active — flips that customer's own Users.Status.
router.post('/toggle-active', requireAuth, async (req, res) => {
  try {
    const { mobile, isActive } = req.body;
    if (!mobile) return res.status(400).json({ success: false, message: 'Mobile required' });
    await executeQuery(
      `UPDATE Users SET Status=@isActive WHERE Mobile=@mobile`,
      { mobile, isActive: !!isActive }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/customer/rates (save/update/delete rates)
router.post('/rates', requireAuth, async (req, res) => {
  try {
    const uid = req.user.UID;
    const { cid, rateID, d_PComm, d_Amt, a_PComm, a_Amt, patti, type } = req.body;

    const rId = rateID ? parseInt(rateID) : 0;
    const isDelete = (rId > 0 && (type == 2 || type === '2' || type === 'delete'));
    const isUpdate = (rId > 0 && (type == 1 || type === '1' || type === 'update'));

    if (isDelete) {
      await executeQuery(
        `DELETE FROM CustomersRates WHERE RateID=@rateID`,
        { rateID: rId }
      );
      return res.json({ success: true, message: 'Rate deleted' });
    }

    const dPC = (d_PComm !== undefined && d_PComm !== null && !isNaN(d_PComm)) ? parseFloat(d_PComm) : 0;
    const dA = (d_Amt !== undefined && d_Amt !== null && !isNaN(d_Amt)) ? parseFloat(d_Amt) : 100;
    const aPC = (a_PComm !== undefined && a_PComm !== null && !isNaN(a_PComm)) ? parseFloat(a_PComm) : 0;
    const aA = (a_Amt !== undefined && a_Amt !== null && !isNaN(a_Amt)) ? parseFloat(a_Amt) : 10;
    const pat = (patti !== undefined && patti !== null && !isNaN(patti)) ? parseFloat(patti) : 0;

    if (isUpdate) {
      await executeQuery(
        `UPDATE CustomersRates SET D_PComm=@dPC, D_Amt=@dA, A_PComm=@aPC, A_Amt=@aA, Patti=@patti
         WHERE RateID=@rateID`,
        { rateID: rId, dPC, dA, aPC, aA, patti: pat }
      );
      return res.json({ success: true, message: 'Rate updated' });
    } else {
      // Get Mobile for this CID
      const cRow = await executeQuery(`SELECT Mobile FROM Customers WHERE CID=@cid AND fUID=@uid`, { cid: parseInt(cid), uid });
      if (!cRow || !cRow[0]) return res.status(404).json({ success: false, message: 'Customer not found' });
      await executeQuery(
        `INSERT INTO CustomersRates (CID, fUID, MobileNo, D_PComm, D_Amt, A_PComm, A_Amt, Patti)
         VALUES (@cid, @uid, @mobile, @dPC, @dA, @aPC, @aA, @patti)`,
        { cid: parseInt(cid), uid, mobile: cRow[0].Mobile, dPC, dA, aPC, aA, patti: pat }
      );
      return res.json({ success: true, message: 'Rate added' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/customer/rates/:rateID
router.delete('/rates/:rateID', requireAuth, async (req, res) => {
  try {
    const rateID = parseInt(req.params.rateID);
    if (!rateID) return res.status(400).json({ success: false, message: 'RateID required' });
    await executeQuery(`DELETE FROM CustomersRates WHERE RateID=@rateID`, { rateID });
    res.json({ success: true, message: 'Rate deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
