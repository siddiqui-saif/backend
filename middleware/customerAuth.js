const jwt = require('jsonwebtoken');

function verifyCustomer(req, res, next) {
  // Sirf customer wala header dekhenge, admin wale ko kabhi try nahi karenge
  const authHeader = req.headers['x-customer-authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Login required' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Zaroori check: ye token customer ka hi hai, admin ka nahi
    // (Admin tokens mein "username" aur "role" hote hain, customer tokens mein sirf "id" aur "name")
    if (decoded.username || decoded.role) {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token is invalid or expired' });
  }
}

module.exports = verifyCustomer;