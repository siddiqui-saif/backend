const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// Sab categories dikhana - PUBLIC (department ke sath, filter bhi kar sakte hain)
router.get('/', async (req, res) => {
  try {
    const { department_id } = req.query;

    let query = `
      SELECT c.*, d.name as department_name
      FROM categories c
      LEFT JOIN departments d ON c.department_id = d.id
    `;
    const params = [];

    if (department_id) {
      params.push(department_id);
      query += ` WHERE c.department_id = $${params.length}`;
    }

    query += ' ORDER BY c.name';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nayi category add karna - PROTECTED
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { name, department_id } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    if (!department_id) {
      return res.status(400).json({ error: 'Please select a department for this category' });
    }

    const result = await pool.query(
      'INSERT INTO categories (name, department_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), department_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'This category already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Category delete karna - PROTECTED (agar koi product use kar raha ho to block)
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const categoryResult = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
    if (categoryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }
    const category = categoryResult.rows[0];

    const usageCheck = await pool.query(
      'SELECT COUNT(*) FROM products WHERE category = $1',
      [category.name]
    );

    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({
        error: `Cannot delete "${category.name}" — it is used by ${usageCheck.rows[0].count} product(s). Change their category first.`,
      });
    }

    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;