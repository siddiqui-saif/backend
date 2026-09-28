const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { validateWholesale } = require('../utils/validators');

const STATUSES = ['New', 'Contacted', 'Closed'];

// Apna alag limiter, taake login ke limiter ke sath counter share na ho
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many inquiries from this connection. Please try again later, or contact us on WhatsApp.' },
});

// Naya inquiry submit karna - PUBLIC
router.post('/', submitLimiter, async (req, res) => {
  try {
    const { error, clean } = validateWholesale(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    await pool.query(
      `INSERT INTO wholesale_inquiries (business_name, contact_person, phone, city, interested_in, estimated_quantity, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clean.business_name, clean.contact_person, clean.phone, clean.city, clean.interested_in, clean.estimated_quantity, clean.message]
    );

    res.json({ message: 'Inquiry submitted successfully' });
  } catch (err) {
    console.error('Wholesale inquiry error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: sab inquiries dekhna - PROTECTED
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wholesale_inquiries ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: status update karna (New/Contacted/Closed) - PROTECTED
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE wholesale_inquiries SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: inquiry delete karna - PROTECTED
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM wholesale_inquiries WHERE id = $1', [id]);
    res.json({ message: 'Inquiry deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;