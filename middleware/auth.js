const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'susu9_mobile_jwt_secret_2024_xK9mP';

function isSuperAdminUser(u) {
  if (!u || u.SubUID) return false;
  return u.IsSuperAdmin === 1 || u.IsSuperAdmin === true || String(u.IsSuperAdmin) === '1' || String(u.SuperAdminStatus).toLowerCase() === 'true';
}

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json({ success: false, message: 'SuperAdmin access required' });
  }
  next();
}

module.exports = { requireAuth, requireSuperAdmin, isSuperAdminUser };
