const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// Sab active departments dikhana - PUBLIC
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM departments WHERE is_active = true ORDER BY display_order, name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin ke liye: sab departments (active + inactive) - PROTECTED
router.get('/all', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY display_order, name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Naya department banana - PROTECTED
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { name, display_order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Department name is required' });
    }

    const result = await pool.query(
      'INSERT INTO departments (name, display_order) VALUES ($1, $2) RETURNING *',
      [name.trim(), display_order || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A department with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Department activate/deactivate - PROTECTED
router.patch('/:id/toggle', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const result = await pool.query(
      'UPDATE departments SET is_active = $1 WHERE id = $2 RETURNING *',
      [is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Department delete karna - PROTECTED (agar use ho raha ho to block)
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const usageCheck = await pool.query('SELECT COUNT(*) FROM products WHERE department_id = $1', [id]);
    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({
        error: `Cannot delete this department — it is used by ${usageCheck.rows[0].count} product(s).`,
      });
    }

    await pool.query('DELETE FROM departments WHERE id = $1', [id]);
    res.json({ message: 'Department deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Size guide dikhana (agar exist kare) - PUBLIC
router.get('/:id/size-guide', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM size_guides WHERE department_id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No size guide for this department' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Size guide banana/update karna - PROTECTED
router.put('/:id/size-guide', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { columns, rows, note } = req.body;

    if (!columns || !rows || !Array.isArray(columns) || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'Columns and rows are required' });
    }

    const existing = await pool.query('SELECT id FROM size_guides WHERE department_id = $1', [id]);

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        'UPDATE size_guides SET columns = $1, rows = $2, note = $3 WHERE department_id = $4 RETURNING *',
        [JSON.stringify(columns), JSON.stringify(rows), note || null, id]
      );
    } else {
      result = await pool.query(
        'INSERT INTO size_guides (department_id, columns, rows, note) VALUES ($1, $2, $3, $4) RETURNING *',
        [id, JSON.stringify(columns), JSON.stringify(rows), note || null]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Size guide delete karna - PROTECTED
router.delete('/:id/size-guide', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM size_guides WHERE department_id = $1', [id]);
    res.json({ message: 'Size guide removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;