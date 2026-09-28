const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const verifyCustomer = require('../middleware/customerAuth');
const { cleanSpaces } = require('../utils/validators');

const COMMENT_MIN = 5;
const COMMENT_MAX = 500;

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many review attempts. Please try again later.' },
});

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Public mein poora naam nahi dikhate: "Ayesha Khan" ban jata hai "Ayesha K."
function maskName(name) {
  const parts = cleanSpaces(name).split(' ').filter(Boolean);
  if (parts.length === 0) return 'Anonymous';
  if (parts.length === 1) return parts[0];
  const initial = Array.from(parts[parts.length - 1])[0].toUpperCase();
  return parts[0] + ' ' + initial + '.';
}

function cleanComment(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function hasReceivedProduct(customerId, productId) {
  const result = await pool.query(
    `SELECT 1 FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = $1 AND oi.product_id = $2 AND o.status = 'Delivered'
     LIMIT 1`,
    [customerId, productId]
  );
  return result.rows.length > 0;
}

// Ek product ke reviews dikhana - PUBLIC (naam masked, customer id nahi jati)
router.get('/product/:productId', async (req, res) => {
  try {
    const productId = parseId(req.params.productId);
    if (!productId) {
      return res.status(400).json({ error: 'Invalid product' });
    }

    const result = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, c.name AS full_name
       FROM reviews r
       LEFT JOIN customers c ON r.customer_id = c.id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [productId]
    );

    res.json(
      result.rows.map(({ full_name, ...review }) => ({
        ...review,
        customer_name: maskName(full_name),
      }))
    );
  } catch (err) {
    console.error('Reviews list error:', err);
    res.status(500).json({ error: 'Could not load reviews.' });
  }
});

// Check karna: kya ye customer is product ko review kar sakta hai - PROTECTED
router.get('/can-review/:productId', verifyCustomer, async (req, res) => {
  try {
    const productId = parseId(req.params.productId);
    if (!productId) {
      return res.status(400).json({ error: 'Invalid product' });
    }
    const customerId = req.customer.id;

    if (!(await hasReceivedProduct(customerId, productId))) {
      return res.json({ canReview: false, reason: 'not_delivered' });
    }

    const existingReview = await pool.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND customer_id = $2',
      [productId, customerId]
    );
    if (existingReview.rows.length > 0) {
      return res.json({ canReview: false, reason: 'already_reviewed' });
    }

    res.json({ canReview: true });
  } catch (err) {
    console.error('Can-review error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Naya review dena - PROTECTED (sirf delivered customer)
router.post('/', verifyCustomer, reviewLimiter, async (req, res) => {
  try {
    const productId = parseId(req.body.product_id);
    const rating = Number(req.body.rating);
    const comment = cleanComment(req.body.comment);
    const customerId = req.customer.id;

    if (!productId) {
      return res.status(400).json({ error: 'Invalid product' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Please select a rating between 1 and 5 stars.', field: 'rating' });
    }
    if (comment && comment.length < COMMENT_MIN) {
      return res.status(400).json({ error: `Please write at least ${COMMENT_MIN} characters, or leave the comment empty.`, field: 'comment' });
    }
    if (comment.length > COMMENT_MAX) {
      return res.status(400).json({ error: `Comment must be ${COMMENT_MAX} characters or fewer.`, field: 'comment' });
    }

    if (!(await hasReceivedProduct(customerId, productId))) {
      return res.status(403).json({ error: 'You can only review products you have received' });
    }

    // Check aur insert ek hi query mein, taake do saath requests se duplicate na bane
    const result = await pool.query(
      `INSERT INTO reviews (product_id, customer_id, rating, comment)
       SELECT $1::int, $2::int, $3::int, $4::text
       WHERE NOT EXISTS (
         SELECT 1 FROM reviews WHERE product_id = $1::int AND customer_id = $2::int
       )
       RETURNING id, product_id, rating, comment, created_at`,
      [productId, customerId, rating, comment || null]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'You have already reviewed this product' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'You have already reviewed this product' });
    }
    console.error('Review submit error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin ke liye: sab reviews dikhana (poora naam) - PROTECTED
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
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid review id' });
    }
    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.json({ message: 'Review deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;