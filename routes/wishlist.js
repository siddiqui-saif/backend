const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyCustomer = require('../middleware/customerAuth');

// Customer ki wishlist dikhana - PROTECTED
router.get('/', verifyCustomer, async (req, res) => {
  try {
    const customerId = req.customer.id;

    const result = await pool.query(
      `SELECT w.id as wishlist_id, p.*
       FROM wishlist w
       JOIN products p ON w.product_id = p.id
       WHERE w.customer_id = $1 AND p.is_active = true
       ORDER BY w.created_at DESC`,
      [customerId]
    );

    const products = result.rows;
    for (let product of products) {
      const sizesResult = await pool.query(
        'SELECT size, color, stock_qty FROM product_sizes WHERE product_id = $1',
        [product.id]
      );
      product.sizes = sizesResult.rows;

      const imagesResult = await pool.query(
        'SELECT id, image_url, color FROM product_images WHERE product_id = $1 ORDER BY id',
        [product.id]
      );
      product.images = imagesResult.rows;
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kya ek product wishlist mein hai (bulk check) - PROTECTED
router.get('/check/:productId', verifyCustomer, async (req, res) => {
  try {
    const { productId } = req.params;
    const customerId = req.customer.id;

    const result = await pool.query(
      'SELECT id FROM wishlist WHERE customer_id = $1 AND product_id = $2',
      [customerId, productId]
    );

    res.json({ inWishlist: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wishlist mein add karna - PROTECTED
router.post('/', verifyCustomer, async (req, res) => {
  try {
    const { product_id } = req.body;
    const customerId = req.customer.id;

    await pool.query(
      'INSERT INTO wishlist (customer_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [customerId, product_id]
    );

    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wishlist se remove karna - PROTECTED
router.delete('/:productId', verifyCustomer, async (req, res) => {
  try {
    const { productId } = req.params;
    const customerId = req.customer.id;

    await pool.query(
      'DELETE FROM wishlist WHERE customer_id = $1 AND product_id = $2',
      [customerId, productId]
    );

    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;