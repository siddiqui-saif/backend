const jwt = require('jsonwebtoken');
const pool = require('../config/db');

async function verifyAdmin(req, res, next) {
  const token = req.cookies?.admin_token;

  if (!token) {
    return res.status(401).json({ error: 'Login required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check karna: kya ye token abhi bhi "valid" hai (logout-all na hua ho, ya password change na hua ho)
    const result = await pool.query('SELECT token_version FROM admins WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0 || result.rows[0].token_version !== decoded.version) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token is invalid or expired' });
  }
}

module.exports = verifyAdmin;