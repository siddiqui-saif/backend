const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const verifyCustomer = require('../middleware/customerAuth');

// Ek product ke reviews dikhana - PUBLIC
router.get('/product/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await pool.query(
      `SELECT r.*, c.name as customer_name
       FROM reviews r
       LEFT JOIN customers c ON r.customer_id = c.id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [productId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check karna: kya ye customer is product ko review kar sakta hai - PROTECTED
router.get('/can-review/:productId', verifyCustomer, async (req, res) => {
  try {
    const { productId } = req.params;
    const customerId = req.customer.id;

    // Check: kya customer ne ye product order kiya aur wo delivered hua
    const deliveredCheck = await pool.query(
      `SELECT DISTINCT o.id FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.customer_id = $1 AND oi.product_id = $2 AND o.status = 'Delivered'`,
      [customerId, productId]
    );

    if (deliveredCheck.rows.length === 0) {
      return res.json({ canReview: false, reason: 'not_delivered' });
    }

    // Check: kya pehle se review de chuka hai
    const existingReview = await pool.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND customer_id = $2',
      [productId, customerId]
    );

    if (existingReview.rows.length > 0) {
      return res.json({ canReview: false, reason: 'already_reviewed' });
    }

    res.json({ canReview: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Naya review dena - PROTECTED (sirf delivered customer)
router.post('/', verifyCustomer, async (req, res) => {
  try {
    const { product_id, rating, comment } = req.body;
    const customer_id = req.customer.id;

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Verify: delivered hai ya nahi
    const deliveredCheck = await pool.query(
      `SELECT DISTINCT o.id FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.customer_id = $1 AND oi.product_id = $2 AND o.status = 'Delivered'`,
      [customer_id, product_id]
    );

    if (deliveredCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You can only review products you have received' });
    }

    // Verify: pehle se review to nahi diya
    const existingReview = await pool.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND customer_id = $2',
      [product_id, customer_id]
    );

    if (existingReview.rows.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this product' });
    }

    const result = await pool.query(
      `INSERT INTO reviews (product_id, customer_id, rating, comment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [product_id, customer_id, rating, comment]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin ke liye: sab reviews dikhana - PROTECTED
router.get('/admin/all', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, c.name as customer_name, p.name as product_name
       FROM reviews r
       LEFT JOIN customers c ON r.customer_id = c.id
       LEFT JOIN products p ON r.product_id = p.id
       ORDER BY r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek review delete karna - PROTECTED
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.json({ message: 'Review deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;