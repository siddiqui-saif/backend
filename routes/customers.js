const { loginLimiter } = require('../middleware/rateLimiter');
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const verifyCustomer = require('../middleware/customerAuth');
const verifyAdmin = require('../middleware/auth');

// Customer register karna
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;

    const existing = await pool.query(
      'SELECT * FROM customers WHERE phone = $1 OR email = $2',
      [phone, email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This phone or email is already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO customers (name, phone, email, password_hash, is_guest)
       VALUES ($1, $2, $3, $4, false) RETURNING id, name, phone, email`,
      [name, phone, email, hashedPassword]
    );

    const customer = result.rows[0];

    const token = jwt.sign(
      { id: customer.id, name: customer.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ message: 'Account created', customer, token });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer login karna
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM customers WHERE phone = $1 AND is_guest = false',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const customer = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, customer.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const token = jwt.sign(
      { id: customer.id, name: customer.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ message: 'Login successful', customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email }, token });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apna profile dekhna - PROTECTED
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
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
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
    await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [newHash, req.customer.id]);

    res.json({ message: 'Password changed successfully' });
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

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE customers SET password_hash = $1 WHERE id = $2 RETURNING id, name',
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

module.exports = router;