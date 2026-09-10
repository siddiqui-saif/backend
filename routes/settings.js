const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// Sab settings dikhana - PUBLIC
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM site_settings');
    const settings = {};
    result.rows.forEach((row) => {
      settings[row.key] = row.value;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek setting update karna - PROTECTED
router.patch('/:key', verifyAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const result = await pool.query(
      `UPDATE site_settings SET value = $1 WHERE key = $2 RETURNING *`,
      [value, key]
    );

    if (result.rows.length === 0) {
      await pool.query('INSERT INTO site_settings (key, value) VALUES ($1, $2)', [key, value]);
    }

    res.json({ message: 'Setting updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;