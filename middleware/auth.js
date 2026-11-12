const jwt = require('jsonwebtoken');
const { executeQuery } = require('../config/database');
const { getSubscription, denialFor } = require('../utils/subscription');

const JWT_SECRET = process.env.JWT_SECRET || 'susu9_mobile_jwt_secret_2024_xK9mP';
const SM_ROLE = 'SuperManager';

function readToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

// Admin / Staff API guard. Also enforces the Admin's subscription: staff
// tokens carry the parent Admin's UID, so staff are cut off together with
// their Admin when the plan expires or the account is blocked.
async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  if (decoded.role === SM_ROLE) {
    return res.status(403).json({ success: false, code: 'WRONG_PORTAL', message: 'Super Manager token is not valid for the Admin portal' });
  }

  req.user = decoded;
  try {
    const sub = await getSubscription(decoded.UID);
    const denial = denialFor(sub);
    if (denial) return res.status(401).json({ success: false, ...denial });
    req.subscription = sub;
  } catch (e) {
    // Never lock everyone out because of a lookup problem.
    req.subscription = null;
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.SuperAdminStatus !== 'True') {
    return res.status(403).json({ success: false, message: 'SuperAdmin access required' });
  }
  next();
}

// ── Super Manager guard ────────────────────────────────────────────────────
// Re-checks IsActive (cached briefly) so a deactivated manager loses access
// without waiting for the token to expire.
const smCache = new Map();
const SM_CACHE_MS = 30 * 1000;

function invalidateSuperManager(smid) {
  if (smid === undefined) smCache.clear();
  else smCache.delete(String(smid));
}

async function requireSuperManager(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Access token required' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
  if (decoded.role !== SM_ROLE || !decoded.SMID) {
    return res.status(403).json({ success: false, message: 'Super Manager access required' });
  }
  try {
    const key = String(decoded.SMID);
    let row = smCache.get(key);
    if (!row || Date.now() - row.at > SM_CACHE_MS) {
      const rows = await executeQuery(`SELECT SMID, Name, Mobile, IsActive FROM SuperManagers WHERE SMID = @id`, { id: decoded.SMID });
      row = { at: Date.now(), value: rows && rows[0] };
      smCache.set(key, row);
    }
    const sm = row.value;
    if (!sm || !(sm.IsActive === true || sm.IsActive === 1)) {
      return res.status(401).json({ success: false, code: 'ACCOUNT_BLOCKED', message: 'Super Manager account inactive hai' });
    }
    req.sm = { SMID: sm.SMID, Name: sm.Name, Mobile: sm.Mobile };
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { requireAuth, requireSuperAdmin, requireSuperManager, invalidateSuperManager, JWT_SECRET, SM_ROLE };
