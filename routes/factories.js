const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// Sab factories ki list (sirf active wali) - PUBLIC
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

// Factory deactivate karna - sirf currently-active products ko "factory ne band kiya" mark karke band karte hain
router.patch('/:id/deactivate', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    await client.query('UPDATE factories SET is_active = false WHERE id = $1', [id]);

    // Sirf wo products jo abhi active hain, unhe "factory ne band kiya" flag ke sath band karte hain
    await client.query(
      `UPDATE products SET is_active = false, deactivated_by_factory = true
       WHERE factory_id = $1 AND is_active = true`,
      [id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Factory and its products deactivated' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Factory wapas activate karna - sirf wahi products wapas active karte hain jo factory ki wajah se band hue the
router.patch('/:id/activate', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    await client.query('UPDATE factories SET is_active = true WHERE id = $1', [id]);

    // Sirf wo products jo "factory ki wajah se" band hue the, unhe wapas active karte hain
    // Jo admin ne khud manually band kiye the (deactivated_by_factory = false), unhe chhorte hain
    await client.query(
      `UPDATE products SET is_active = true, deactivated_by_factory = false
       WHERE factory_id = $1 AND deactivated_by_factory = true`,
      [id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Factory and its previously-active products reactivated' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;