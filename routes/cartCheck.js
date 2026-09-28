const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');

const MAX_ITEMS = 50;

const checkLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please try again in a moment.' },
});

// Cart ke items ka live stock, price aur availability - PUBLIC (koi personal data nahi)
router.post('/', checkLimiter, async (req, res) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ items: [] });
    }
    if (items.length > MAX_ITEMS) {
      return res.status(400).json({ error: 'Too many items to check.' });
    }

    const clean = [];
    for (const it of items) {
      const productId = Number(it && it.product_id);
      const size = String(it && it.size != null ? it.size : '').trim();
      const color = it && it.color ? String(it.color).trim() || null : null;

      if (!Number.isInteger(productId) || productId < 1) continue;
      if (!size || size.length > 50 || (color && color.length > 50)) continue;

      clean.push({ product_id: productId, size, color });
    }

    const ids = [...new Set(clean.map((i) => i.product_id))];
    if (ids.length === 0) {
      return res.json({ items: [] });
    }

    const productsResult = await pool.query(
      'SELECT id, price, is_active FROM products WHERE id = ANY($1::int[])',
      [ids]
    );
    const sizesResult = await pool.query(
      'SELECT product_id, size, color, stock_qty FROM product_sizes WHERE product_id = ANY($1::int[])',
      [ids]
    );

    const productById = new Map(productsResult.rows.map((p) => [p.id, p]));

    const result = clean.map((it) => {
      const product = productById.get(it.product_id);
      const variant = sizesResult.rows.find(
        (s) =>
          s.product_id === it.product_id &&
          s.size === it.size &&
          (s.color || null) === (it.color || null)
      );

      return {
        product_id: it.product_id,
        size: it.size,
        color: it.color,
        available: !!product && !!product.is_active && !!variant,
        stock: variant ? Math.max(0, parseInt(variant.stock_qty, 10) || 0) : 0,
        price: product ? parseFloat(product.price) : null,
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json({ items: result });
  } catch (err) {
    console.error('Cart check error:', err);
    res.status(500).json({ error: 'Could not check the cart right now.' });
  }
});

module.exports = router;