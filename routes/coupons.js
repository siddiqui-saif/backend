const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { couponLimiter } = require('../middleware/rateLimiter');

// Admin: sab coupons dikhana - PROTECTED
router.get('/admin/all', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: naya coupon banana - PROTECTED
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const {
      code, discount_type, discount_value, min_order_amount,
      usage_limit, per_customer_limit, expiry_date,
    } = req.body;

    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'Code, discount type, and value are required' });
    }

    if (!['percentage', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: 'Discount type must be percentage or fixed' });
    }

    const result = await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, usage_limit, per_customer_limit, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        code.toUpperCase().trim(),
        discount_type,
        discount_value,
        min_order_amount || 0,
        usage_limit || null,
        per_customer_limit || 1,
        expiry_date || null,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A coupon with this code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Admin: coupon activate/deactivate - PROTECTED
router.patch('/:id/toggle', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const result = await pool.query(
      'UPDATE coupons SET is_active = $1 WHERE id = $2 RETURNING *',
      [is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Coupon not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: coupon delete karna - PROTECTED
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM coupons WHERE id = $1', [id]);
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer: coupon validate karna (checkout ke waqt) - PUBLIC
router.post('/validate', couponLimiter, async (req, res) => {
  try {
    const { code, order_total, phone } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Please enter a coupon code' });
    }

    const couponResult = await pool.query(
      'SELECT * FROM coupons WHERE code = $1',
      [code.toUpperCase().trim()]
    );

    if (couponResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }

    const coupon = couponResult.rows[0];

    if (!coupon.is_active) {
      return res.status(400).json({ error: 'This coupon is no longer active' });
    }

    if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
      return res.status(400).json({ error: 'This coupon has expired' });
    }

    if (order_total < parseFloat(coupon.min_order_amount)) {
      return res.status(400).json({
        error: `This coupon requires a minimum order of Rs ${parseFloat(coupon.min_order_amount).toLocaleString()}`,
      });
    }

    if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
      return res.status(400).json({ error: 'This coupon has reached its usage limit' });
    }

    // Per-customer limit check (phone number se, chahe guest ho ya login)
    if (phone) {
      const usageCheck = await pool.query(
        'SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = $1 AND phone = $2',
        [coupon.id, phone]
      );
      const timesUsed = parseInt(usageCheck.rows[0].count);
      if (timesUsed >= coupon.per_customer_limit) {
        return res.status(400).json({ error: 'You have already used this coupon the maximum number of times' });
      }
    }

    // Discount calculate karna
    let discountAmount = 0;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (order_total * parseFloat(coupon.discount_value)) / 100;
    } else {
      discountAmount = parseFloat(coupon.discount_value);
    }
    discountAmount = Math.min(discountAmount, order_total);

    res.json({
      valid: true,
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      discount_amount: Math.round(discountAmount * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;