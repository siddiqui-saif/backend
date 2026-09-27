const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');

// Naya inquiry submit karna - PUBLIC
router.post('/', loginLimiter, async (req, res) => {
  try {
    const { business_name, contact_person, phone, city, interested_in, estimated_quantity, message } = req.body;

    if (!business_name || !contact_person || !phone) {
      return res.status(400).json({ error: 'Business name, contact person, and phone are required' });
    }

    const result = await pool.query(
      `INSERT INTO wholesale_inquiries (business_name, contact_person, phone, city, interested_in, estimated_quantity, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [business_name, contact_person, phone, city || null, interested_in || null, estimated_quantity || null, message || null]
    );

    res.json({ message: 'Inquiry submitted successfully', inquiry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
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