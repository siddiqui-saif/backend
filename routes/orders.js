const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { validateCheckout } = require('../utils/validators');

const MAX_ITEMS_PER_ORDER = 30;
const MAX_QTY_PER_ITEM = 20;
const ALLOWED_SOURCES = ['Website', 'WhatsApp', 'Phone Call', 'Word of Mouth', 'Other'];
const CANCEL_REASONS = ['Refused at delivery', 'Unreachable', 'Fake order', 'Customer changed mind', 'Out of stock', 'Other'];

function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'CHR-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Login cookie se customer pehchanta hai. Cookie na ho ya galat ho to guest order maana jata hai.
async function getCustomerIdFromCookie(req) {
  const token = req.cookies && req.cookies.customer_token;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT id, token_version FROM customers WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0 || result.rows[0].token_version !== decoded.version) return null;
    return result.rows[0].id;
  } catch (err) {
    return null;
  }
}

function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'Order must contain at least one item' };
  }
  if (items.length > MAX_ITEMS_PER_ORDER) {
    return { error: `An order can contain up to ${MAX_ITEMS_PER_ORDER} different items.` };
  }

  const clean = [];
  for (const item of items) {
    const productId = Number(item && item.product_id);
    const quantity = Number(item && item.quantity);
    const size = String(item && item.size != null ? item.size : '').trim();
    const color = item && item.color ? String(item.color).trim() || null : null;

    if (!Number.isInteger(productId) || productId < 1) {
      return { error: 'Invalid product in cart. Please refresh the page and try again.' };
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: 'Invalid quantity in cart.' };
    }
    if (quantity > MAX_QTY_PER_ITEM) {
      return { error: `You can order up to ${MAX_QTY_PER_ITEM} pieces of one item. For bulk orders, please use Wholesale Inquiries.` };
    }
    if (!size || size.length > 50 || (color && color.length > 50)) {
      return { error: 'Invalid size or color in cart.' };
    }
    clean.push({ product_id: productId, quantity, size, color });
  }
  return { error: null, clean };
}

async function calculateCouponDiscount(client, code, orderTotal, phone) {
  const couponResult = await client.query(
    'SELECT * FROM coupons WHERE code = $1',
    [code.toUpperCase().trim()]
  );

  if (couponResult.rows.length === 0) {
    throw new Error('Invalid coupon code');
  }

  const coupon = couponResult.rows[0];

  if (!coupon.is_active) {
    throw new Error('This coupon is no longer active');
  }
  if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
    throw new Error('This coupon has expired');
  }
  if (orderTotal < parseFloat(coupon.min_order_amount)) {
    throw new Error(`This coupon requires a minimum order of Rs ${parseFloat(coupon.min_order_amount).toLocaleString()}`);
  }
  if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
    throw new Error('This coupon has reached its usage limit');
  }

  if (phone) {
    const usageCheck = await client.query(
      'SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = $1 AND phone = $2',
      [coupon.id, phone]
    );
    if (parseInt(usageCheck.rows[0].count) >= coupon.per_customer_limit) {
      throw new Error('You have already used this coupon the maximum number of times');
    }
  }

  let discountAmount = 0;
  if (coupon.discount_type === 'percentage') {
    discountAmount = (orderTotal * parseFloat(coupon.discount_value)) / 100;
  } else {
    discountAmount = parseFloat(coupon.discount_value);
  }
  discountAmount = Math.min(discountAmount, orderTotal);

  return {
    couponId: coupon.id,
    code: coupon.code,
    discountAmount: Math.round(discountAmount * 100) / 100,
  };
}

// Naya order create karna - PUBLIC
router.post('/', async (req, res) => {
  const { error: checkoutError, clean } = validateCheckout(req.body);
  if (checkoutError) {
    return res.status(400).json({ error: checkoutError });
  }

  const { error: itemsError, clean: cleanItems } = validateOrderItems(req.body.items);
  if (itemsError) {
    return res.status(400).json({ error: itemsError });
  }

  const couponCode = req.body.coupon_code
    ? String(req.body.coupon_code).toUpperCase().trim().slice(0, 30)
    : null;
  const source = ALLOWED_SOURCES.includes(req.body.source) ? req.body.source : 'Website';
  const customerId = await getCustomerIdFromCookie(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const verifiedItems = [];
    let total = 0;

    for (const item of cleanItems) {
      const productResult = await client.query(
        'SELECT id, name, price, is_active FROM products WHERE id = $1',
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`Product not found (ID: ${item.product_id})`);
      }

      const product = productResult.rows[0];

      if (!product.is_active) {
        throw new Error(`"${product.name}" is no longer available`);
      }

      const verifiedPrice = parseFloat(product.price);

      verifiedItems.push({
        product_id: item.product_id,
        product_name: product.name,
        size: item.size,
        color: item.color,
        quantity: item.quantity,
        price: verifiedPrice,
      });

      total += verifiedPrice * item.quantity;
    }

    let finalDiscount = 0;
    let couponId = null;
    let appliedCouponCode = null;
    if (couponCode) {
      const couponResult = await calculateCouponDiscount(client, couponCode, total, clean.phone);
      finalDiscount = couponResult.discountAmount;
      couponId = couponResult.couponId;
      appliedCouponCode = couponResult.code;
    }

    const finalTotal = Math.max(0, total - finalDiscount);

    let trackingCode;
    let inserted = false;
    let newOrder;
    let attempts = 0;

    while (!inserted && attempts < 5) {
      trackingCode = generateTrackingCode();
      try {
        const orderResult = await client.query(
          `INSERT INTO orders (customer_id, customer_name, phone, address, landmark, customer_note, payment_method, source, total_amount, coupon_code, discount_amount, status, tracking_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
          [customerId, clean.customer_name, clean.phone, clean.address, clean.landmark, clean.customer_note, 'COD', source, finalTotal, appliedCouponCode, finalDiscount, 'Order Placed', trackingCode]
        );
        newOrder = orderResult.rows[0];
        inserted = true;
      } catch (err) {
        if (err.code === '23505') {
          attempts++;
          continue;
        }
        throw err;
      }
    }

    if (!inserted) {
      throw new Error('Could not generate a unique tracking code, please try again.');
    }

    for (const item of verifiedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, size, color, quantity, price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newOrder.id, item.product_id, item.size, item.color, item.quantity, item.price]
      );

      const stockCheck = await client.query(
        `UPDATE product_sizes SET stock_qty = stock_qty - $1
         WHERE product_id = $2 AND size = $3 AND color IS NOT DISTINCT FROM $4
         RETURNING stock_qty`,
        [item.quantity, item.product_id, item.size, item.color]
      );

      if (stockCheck.rows.length === 0 || stockCheck.rows[0].stock_qty < 0) {
        throw new Error(`"${item.product_name}" (Size ${item.size}) is out of stock`);
      }
    }

    if (couponId) {
      await client.query(
        'INSERT INTO coupon_usage (coupon_id, customer_id, phone, order_id) VALUES ($1, $2, $3, $4)',
        [couponId, customerId, clean.phone, newOrder.id]
      );
      await client.query('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1', [couponId]);
    }

    await client.query('COMMIT');
    res.json(newOrder);

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Sab orders dikhana - PROTECTED
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard analytics - PROTECTED
router.get('/analytics/summary', verifyAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;

    const result = await pool.query(
      `SELECT p.id as product_id, p.name as product_name, p.category,
              f.name as factory_name, f.city as factory_city,
              SUM(oi.quantity) as total_quantity,
              SUM(oi.quantity * oi.price) as total_revenue
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       JOIN products p ON oi.product_id = p.id
       LEFT JOIN factories f ON p.factory_id = f.id
       WHERE o.status != 'Cancelled' AND o.created_at BETWEEN $1 AND $2
       GROUP BY p.id, p.name, p.category, f.name, f.city
       ORDER BY total_revenue DESC`,
      [from, to]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek order ki poori detail - PROTECTED
router.get('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    const itemsResult = await pool.query(
      `SELECT oi.*, p.name as product_name, f.name as factory_name, f.city as factory_city
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN factories f ON p.factory_id = f.id
       WHERE oi.order_id = $1`,
      [id]
    );
    order.items = itemsResult.rows;

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track order karna - PUBLIC
router.get('/track/:code', async (req, res) => {
  try {
    const { code } = req.params;

    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE tracking_code = $1',
      [code.toUpperCase().trim()]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'No order found with this tracking code. Please check and try again.' });
    }

    const order = orderResult.rows[0];

    const itemsResult = await pool.query(
      `SELECT oi.*, p.name as product_name
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [order.id]
    );
    order.items = itemsResult.rows;

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer khud delivery confirm kare - PUBLIC
router.patch('/track/:code/confirm-delivery', async (req, res) => {
  try {
    const { code } = req.params;

    const orderResult = await pool.query('SELECT * FROM orders WHERE tracking_code = $1', [code.toUpperCase().trim()]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    if (order.status === 'Delivered') {
      return res.status(400).json({ error: 'Order is already marked as delivered' });
    }
    if (order.status === 'Cancelled') {
      return res.status(400).json({ error: 'This order was cancelled' });
    }

    const result = await pool.query(
      'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
      ['Delivered', order.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order status update karna - PROTECTED
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    let result;
    if (status === 'Delivered') {
      result = await pool.query(
        'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
    } else {
      result = await pool.query(
        'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmed-by-call toggle karna - PROTECTED
router.patch('/:id/confirm-call', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmed } = req.body;
    const result = await pool.query(
      'UPDATE orders SET confirmed_by_call = $1 WHERE id = $2 RETURNING *',
      [confirmed, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order cancel karna (wajah ke sath, wajah zaroori nahi) - PROTECTED
router.patch('/:id/cancel', verifyAdmin, async (req, res) => {
  const { id } = req.params;

  let cancelReason = null;
  const reasonRaw = req.body && req.body.reason;
  if (reasonRaw !== undefined && reasonRaw !== null && reasonRaw !== '') {
    if (!CANCEL_REASONS.includes(reasonRaw)) {
      return res.status(400).json({ error: 'Invalid cancel reason' });
    }
    cancelReason = reasonRaw;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderCheck = await client.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderCheck.rows.length === 0) {
      throw new Error('Order not found');
    }
    const order = orderCheck.rows[0];

    if (order.status === 'Cancelled') {
      throw new Error('Order is already cancelled');
    }
    if (order.status === 'Delivered') {
      throw new Error('Delivered orders cannot be cancelled');
    }

    const itemsResult = await client.query('SELECT * FROM order_items WHERE order_id = $1', [id]);

    for (const item of itemsResult.rows) {
      await client.query(
        `UPDATE product_sizes SET stock_qty = stock_qty + $1
         WHERE product_id = $2 AND size = $3 AND color IS NOT DISTINCT FROM $4`,
        [item.quantity, item.product_id, item.size, item.color]
      );
    }

    if (order.coupon_code) {
      const couponResult = await client.query('SELECT id FROM coupons WHERE code = $1', [order.coupon_code]);
      if (couponResult.rows.length > 0) {
        await client.query(
          'UPDATE coupons SET usage_count = GREATEST(usage_count - 1, 0) WHERE id = $1',
          [couponResult.rows[0].id]
        );
        await client.query(
          'DELETE FROM coupon_usage WHERE coupon_id = $1 AND order_id = $2',
          [couponResult.rows[0].id, id]
        );
      }
    }

    const result = await client.query(
      'UPDATE orders SET status = $1, cancel_reason = $2 WHERE id = $3 RETURNING *',
      ['Cancelled', cancelReason, id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Order cancelled, stock restored', order: result.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Courier/tracking details add karna - PROTECTED
router.patch('/:id/courier', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { courier_name, tracking_number, estimated_delivery } = req.body;

    const result = await pool.query(
      `UPDATE orders SET courier_name = $1, tracking_number = $2, status = 'Shipped', estimated_delivery = $3
       WHERE id = $4 RETURNING *`,
      [courier_name, tracking_number, estimated_delivery || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;