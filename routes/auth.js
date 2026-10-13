const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { executeStoredProcedure, executeQuery } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

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
      // Check if user exists with matching password but expired validity
      const expiredCheck = await executeQuery(
        `SELECT UID, Mobile, Validity, Status, IsSuperAdmin, IsRefreshStatus FROM Users WHERE Mobile = @mobile AND Password = @password`,
        { mobile, password }
      );
      if (expiredCheck && expiredCheck.length > 0) {
        const expUser = expiredCheck[0];
        const valDate = expUser.Validity ? new Date(expUser.Validity) : null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (!valDate || valDate.getTime() < today.getTime()) {
          const isSAExp = (expUser.IsSuperAdmin === 1 || expUser.IsSuperAdmin === true || String(expUser.IsSuperAdmin) === '1' || String(expUser.IsSuperAdmin).toLowerCase() === 'true');
          const expPayload = {
            UID: expUser.UID,
            Mobile: mobile,
            SuperAdmin: 'SuperAdmin',
            SuperAdminStatus: isSAExp ? 'True' : 'False',
            IsSuperAdmin: isSAExp ? 1 : 0,
            IsRefreshStatus: expUser.IsRefreshStatus ? expUser.IsRefreshStatus.toString() : 'False',
            SubUID: null,
            isExpired: true,
            validity: expUser.Validity
          };
          const expToken = generateToken(expPayload);
          return res.status(200).json({
            success: true,
            expired: true,
            token: expToken,
            user: expPayload,
            message: 'Aapka free trial ya subscription expire ho chuka hai. Kripya plan renew karein.'
          });
        }
      }
      return res.status(401).json({ success: false, message: 'Mobile ya password galat hai' });
    }

    const user = users[0];
    let isRefreshStatus = 'False';
    let isSuperAdminFromDb = null;
    try {
      const rf = await executeQuery(`SELECT IsRefreshStatus, IsSuperAdmin FROM Users WHERE UID=@uid`, { uid: user.UID });
      if (rf && rf[0]) {
        isRefreshStatus = rf[0].IsRefreshStatus?.toString() || 'False';
        isSuperAdminFromDb = rf[0].IsSuperAdmin;
      }
    } catch (e) {}

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const uValDate = user.Validity ? new Date(user.Validity) : null;
    const isExp = !uValDate || uValDate.getTime() < today.getTime();
    const daysRem = uValDate ? Math.max(0, Math.ceil((uValDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))) : 0;

    let isSuperAdminVal = 0;
    const rawSA = isSuperAdminFromDb !== null && isSuperAdminFromDb !== undefined ? isSuperAdminFromDb : user.IsSuperAdmin;
    if (rawSA !== null && rawSA !== undefined) {
      isSuperAdminVal = (rawSA === 1 || rawSA === true || String(rawSA) === '1' || String(rawSA).toLowerCase() === 'true') ? 1 : 0;
    }

    const payload = {
      UID: user.UID,
      Mobile: mobile,
      SuperAdmin: 'SuperAdmin',
      SuperAdminStatus: isSuperAdminVal === 1 ? 'True' : 'False',
      IsSuperAdmin: isSuperAdminVal,
      IsRefreshStatus: isRefreshStatus,
      SubUID: null,
      validity: user.Validity,
      isExpired: isExp,
      daysRemaining: daysRem
    };

    const token = generateToken(payload);
    res.json({ success: true, token, user: payload });
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

    // Check parent admin subscription validity
    const parentRows = await executeQuery(`SELECT Validity, Status FROM Users WHERE UID = @parentUID`, { parentUID: subUser.fcreatedUID });
    if (parentRows && parentRows.length > 0) {
      const pVal = parentRows[0].Validity ? new Date(parentRows[0].Validity) : null;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (!pVal || pVal.getTime() < today.getTime()) {
        return res.status(403).json({
          success: false,
          expired: true,
          message: 'Main Admin ka subscription expire ho chuka hai. Kripya Admin se renew karne ko kahein.'
        });
      }
    }

    const access = await bindAccessRight(subUserID);

    const payload = {
      UID: subUser.fcreatedUID,
      Mobile: subUser.Mobile || '',
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
    const user = { ...req.user };
    if (user.SubUID) {
      const access = await bindAccessRight(user.SubUID);
      Object.assign(user, access);
    }
    // Fetch latest validity and super admin status from DB for main user
    if (!user.SubUID && user.UID) {
      const uRows = await executeQuery(`SELECT Validity, IsSuperAdmin FROM Users WHERE UID = @uid`, { uid: user.UID });
      if (uRows && uRows[0]) {
        const uVal = uRows[0].Validity ? new Date(uRows[0].Validity) : null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        user.validity = uRows[0].Validity;
        user.isExpired = !uVal || uVal.getTime() < today.getTime();
        user.daysRemaining = uVal ? Math.max(0, Math.ceil((uVal.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))) : 0;

        const isSA = (uRows[0].IsSuperAdmin === 1 || uRows[0].IsSuperAdmin === true || String(uRows[0].IsSuperAdmin) === '1' || String(uRows[0].IsSuperAdmin).toLowerCase() === 'true') ? 1 : 0;
        user.IsSuperAdmin = isSA;
        user.SuperAdminStatus = isSA === 1 ? 'True' : 'False';
      }
    } else if (user.SubUID) {
      user.IsSuperAdmin = 0;
      user.SuperAdminStatus = 'False';
    }
    res.json({ success: true, user });
  } catch (e) {
    res.json({ success: true, user: req.user });
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
router.post('/register', async (req, res) => {
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
      let trialDays = 15;
      try {
        const confRows = await executeQuery("SELECT ConfigValue FROM SystemConfig WHERE ConfigKey='FREE_TRIAL_DAYS'");
        if (confRows && confRows[0] && !isNaN(parseInt(confRows[0].ConfigValue))) {
          trialDays = parseInt(confRows[0].ConfigValue);
        }
      } catch(e) {}
      await executeQuery(`UPDATE Users SET Status='True', Validity=DATEADD(day, @trialDays, CAST(GETDATE() AS date)) WHERE UID=@uid`, { uid, trialDays });
      try {
        const { logActivity } = require('../helpers/activityLogger');
        await logActivity({
          fUID: uid,
          actorType: 'User',
          actorID: String(uid),
          actorName: mobile,
          module: 'Auth',
          action: 'User Registration',
          entityType: 'User',
          entityID: String(uid),
          description: `New user registered with mobile ${mobile} (${trialDays}-day free trial granted)`
        });
      } catch(e) {}
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
