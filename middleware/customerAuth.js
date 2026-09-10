const jwt = require('jsonwebtoken');

function verifyCustomer(req, res, next) {
  const authHeader = req.headers['x-customer-authorization'] || req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Login required' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token is invalid or expired' });
  }
}

module.exports = verifyCustomer;