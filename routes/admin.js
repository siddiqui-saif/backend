const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function setAdminCookie(res, admin) {
  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role, version: admin.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Admin login - IP rate limit + account-level lockout dono
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const admin = result.rows[0];

    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(admin.locked_until) - new Date()) / 60000);
      return res.status(403).json({ error: `Account temporarily locked. Try again in ${minutesLeft} minute(s).` });
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash);

    if (!passwordMatch) {
      const attempts = (admin.failed_login_attempts || 0) + 1;
      if (attempts >= LOCKOUT_THRESHOLD) {
        await pool.query(
          'UPDATE admins SET failed_login_attempts = 0, locked_until = $1 WHERE id = $2',
          [new Date(Date.now() + LOCKOUT_DURATION_MS), admin.id]
        );
        return res.status(403).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      await pool.query('UPDATE admins SET failed_login_attempts = $1 WHERE id = $2', [attempts, admin.id]);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await pool.query('UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [admin.id]);

    setAdminCookie(res, admin);
    res.json({ message: 'Login successful', admin: { id: admin.id, username: admin.username } });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current session check - PROTECTED (frontend ye use karega "login hai ya nahi" jaanne ke liye)
router.get('/me', verifyAdmin, async (req, res) => {
  res.json({ id: req.admin.id, username: req.admin.username });
});

// Is device se logout - PROTECTED
router.post('/logout', verifyAdmin, (req, res) => {
  res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.json({ message: 'Logged out' });
});

// SAB devices se logout - PROTECTED
router.post('/logout-all', verifyAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE admins SET token_version = token_version + 1 WHERE id = $1', [req.admin.id]);
    res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.json({ message: 'Logged out from all devices' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password - PROTECTED (baaki devices se khud-ba-khud logout kar deta hai)
router.patch('/change-password', verifyAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.admin.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Please provide current and new password' });
    }
    if (newPassword.length < 8 || !/\d/.test(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include a number' });
    }

    const result = await pool.query('SELECT * FROM admins WHERE id = $1', [adminId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const admin = result.rows[0];
    const passwordMatch = await bcrypt.compare(currentPassword, admin.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      'UPDATE admins SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING *',
      [newHash, adminId]
    );

    setAdminCookie(res, updated.rows[0]);
    res.json({ message: 'Password changed successfully. You have been logged out of other devices.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;