const jwt = require('jsonwebtoken');
const pool = require('../config/db');

async function verifyCustomer(req, res, next) {
  const token = req.cookies?.customer_token;

  if (!token) {
    return res.status(401).json({ error: 'Login required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query('SELECT token_version FROM customers WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0 || result.rows[0].token_version !== decoded.version) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token is invalid or expired' });
  }
}

module.exports = verifyCustomer;