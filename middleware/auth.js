const jwt = require('jsonwebtoken');

function verifyAdmin(req, res, next) {
  // Token header se nikalna
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Login zaroori hai (token nahi mila)' });
  }

  // Header aisi hoti hai: "Bearer <token>" - hume sirf token chahiye
  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token format galat hai' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded; // Admin ki details request ke sath aage bhej dena
    next(); // Sab theek hai, aage jane dein
  } catch (err) {
    return res.status(403).json({ error: 'Token invalid ya expire ho chuka hai' });
  }
}

module.exports = verifyAdmin;