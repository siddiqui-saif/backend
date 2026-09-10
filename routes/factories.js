const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// Sab factories ki list (sirf active wali) - PUBLIC, koi login zaroori nahi
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM factories WHERE is_active = true ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin ke liye: sab factories dikhana - PROTECTED
router.get('/all', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM factories ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nayi factory add karna - PROTECTED
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { name, city, contact } = req.body;
    const result = await pool.query(
      'INSERT INTO factories (name, city, contact) VALUES ($1, $2, $3) RETURNING *',
      [name, city, contact]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Factory deactivate karna - PROTECTED
router.patch('/:id/deactivate', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    await client.query('UPDATE factories SET is_active = false WHERE id = $1', [id]);
    await client.query('UPDATE products SET is_active = false WHERE factory_id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: 'Factory aur uske products deactivate ho gaye' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Factory wapas activate karna - PROTECTED
router.patch('/:id/activate', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    await client.query('UPDATE factories SET is_active = true WHERE id = $1', [id]);
    await client.query('UPDATE products SET is_active = true WHERE factory_id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: 'Factory aur uske products wapas activate ho gaye' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;