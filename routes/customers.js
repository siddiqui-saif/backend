const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const verifyCustomer = require('../middleware/customerAuth');
const verifyAdmin = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { normalizePhone } = require('../utils/phoneHelper');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function isValidPassword(password) {
  return password && password.length >= 8 && /\d/.test(password);
}

function setCustomerCookie(res, customer) {
  const token = jwt.sign(
    { id: customer.id, name: customer.name, version: customer.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.cookie('customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Customer register karna
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    const normalizedPhone = normalizePhone(phone);

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Name, phone, and password are required' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include a number' });
    }

    const existing = await pool.query(
      'SELECT * FROM customers WHERE phone = $1 OR (email = $2 AND email IS NOT NULL)',
      [normalizedPhone, email || null]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This phone or email is already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO customers (name, phone, email, password_hash, is_guest)
       VALUES ($1, $2, $3, $4, false) RETURNING id, name, phone, email, token_version`,
      [name, normalizedPhone, email || null, hashedPassword]
    );

    const customer = result.rows[0];

    setCustomerCookie(res, customer);
    res.json({
      message: 'Account created',
      customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email },
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer login karna - phone ya email dono se
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Please enter your phone/email and password' });
    }

    const normalizedIdentifier = normalizePhone(identifier);

    const result = await pool.query(
      'SELECT * FROM customers WHERE (phone = $1 OR phone = $2 OR email = $2) AND is_guest = false',
      [normalizedIdentifier, identifier]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const customer = result.rows[0];

    if (customer.locked_until && new Date(customer.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(customer.locked_until) - new Date()) / 60000);
      return res.status(403).json({ error: `Account temporarily locked. Try again in ${minutesLeft} minute(s).` });
    }

    const passwordMatch = await bcrypt.compare(password, customer.password_hash);

    if (!passwordMatch) {
      const attempts = (customer.failed_login_attempts || 0) + 1;
      if (attempts >= LOCKOUT_THRESHOLD) {
        await pool.query(
          'UPDATE customers SET failed_login_attempts = 0, locked_until = $1 WHERE id = $2',
          [new Date(Date.now() + LOCKOUT_DURATION_MS), customer.id]
        );
        return res.status(403).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      await pool.query('UPDATE customers SET failed_login_attempts = $1 WHERE id = $2', [attempts, customer.id]);
      return res.status(401).json({ error: 'Incorrect password' });
    }

    await pool.query('UPDATE customers SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [customer.id]);

    setCustomerCookie(res, customer);
    res.json({
      message: 'Login successful',
      customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email },
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current session check - PROTECTED
router.get('/me', verifyCustomer, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, phone, email, created_at FROM customers WHERE id = $1',
      [req.customer.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apni profile details update karna - PROTECTED
router.put('/me', verifyCustomer, async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await pool.query(
      'UPDATE customers SET name = $1, email = $2 WHERE id = $3 RETURNING id, name, phone, email',
      [name, email, req.customer.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apna password khud change karna - PROTECTED
router.patch('/me/change-password', verifyCustomer, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Please provide current and new password' });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include a number' });
    }

    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = result.rows[0];
    const passwordMatch = await bcrypt.compare(currentPassword, customer.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      'UPDATE customers SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING *',
      [newHash, req.customer.id]
    );

    setCustomerCookie(res, updated.rows[0]);
    res.json({ message: 'Password changed successfully. You have been logged out of other devices.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Is device se logout - PROTECTED
router.post('/logout', verifyCustomer, (req, res) => {
  res.clearCookie('customer_token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.json({ message: 'Logged out' });
});

// SAB devices se logout - PROTECTED
router.post('/logout-all', verifyCustomer, async (req, res) => {
  try {
    await pool.query('UPDATE customers SET token_version = token_version + 1 WHERE id = $1', [req.customer.id]);
    res.clearCookie('customer_token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
    res.json({ message: 'Logged out from all devices' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apne purane orders dekhna - PROTECTED
router.get('/:id/orders', verifyCustomer, async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) !== req.customer.id) {
      return res.status(403).json({ error: 'You can only view your own orders' });
    }

    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin ke liye: sab registered customers dikhana - PROTECTED
router.get('/admin/all', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.phone, c.email, c.created_at,
              COUNT(o.id) as order_count,
              COALESCE(SUM(CASE WHEN o.status != 'Cancelled' THEN o.total_amount ELSE 0 END), 0) as total_spent
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       WHERE c.is_guest = false
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: kisi customer ka password reset karna (support ke liye) - PROTECTED
router.patch('/admin/:id/reset-password', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters and include a number' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE customers SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING id, name',
      [newHash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: `Password reset for ${result.rows[0].name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: customer delete karna (account only, orders "guest" ban jayenge) - PROTECTED
router.delete('/admin/:id', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { deleteOrders } = req.query; // 'true' ya 'false' string ki tarah aayega

    await client.query('BEGIN');

    const customerCheck = await client.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (customerCheck.rows.length === 0) {
      throw new Error('Customer not found');
    }

    if (deleteOrders === 'true') {
      // Poora delete: customer ke saath uske orders bhi
      await client.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)', [id]);
      await client.query('DELETE FROM orders WHERE customer_id = $1', [id]);
    } else {
      // Sirf account delete, orders "guest" ban jayenge
      await client.query('UPDATE orders SET customer_id = NULL WHERE customer_id = $1', [id]);
    }

    // Wishlist aur coupon usage records hamesha delete honge (ye account-specific hain)
    await client.query('DELETE FROM wishlist WHERE customer_id = $1', [id]);
    await client.query('DELETE FROM coupon_usage WHERE customer_id = $1', [id]);
    await client.query('DELETE FROM customers WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ message: 'Customer deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});


module.exports = router;