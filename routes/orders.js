const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'CHR-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Naya order create karna - PUBLIC
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, phone, address, landmark, payment_method, source, items, customer_id, coupon_code, discount_amount } = req.body;

    await client.query('BEGIN');

    let total = 0;
    for (let item of items) {
      total += item.price * item.quantity;
    }

    const finalDiscount = discount_amount || 0;
    const finalTotal = Math.max(0, total - finalDiscount);

    let trackingCode;
    let inserted = false;
    let newOrder;
    let attempts = 0;

    while (!inserted && attempts < 5) {
      trackingCode = generateTrackingCode();
      try {
        const orderResult = await client.query(
          `INSERT INTO orders (customer_id, customer_name, phone, address, landmark, payment_method, source, total_amount, coupon_code, discount_amount, status, tracking_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [customer_id || null, customer_name, phone, address, landmark || null, payment_method || 'COD', source || 'Website', finalTotal, coupon_code || null, finalDiscount, 'Order Placed', trackingCode]
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

    for (let item of items) {
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
        throw new Error(`Out of stock: Product ${item.product_id}, Size ${item.size}`);
      }
    }

    if (coupon_code) {
      const couponResult = await client.query('SELECT id FROM coupons WHERE code = $1', [coupon_code.toUpperCase()]);
      if (couponResult.rows.length > 0) {
        const couponId = couponResult.rows[0].id;
        await client.query(
          'INSERT INTO coupon_usage (coupon_id, customer_id, phone, order_id) VALUES ($1, $2, $3, $4)',
          [couponId, customer_id || null, phone, newOrder.id]
        );
        await client.query('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = $1', [couponId]);
      }
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

// Ek order ki poori detail (admin, id se) - PROTECTED
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

// Customer ke liye: order tracking code se track karna - PUBLIC
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

// Customer khud delivery confirm kare (tracking code se) - PUBLIC
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
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
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
    const result = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
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

// Order cancel karna - PROTECTED
router.patch('/:id/cancel', verifyAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

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

    for (let item of itemsResult.rows) {
      await client.query(
        `UPDATE product_sizes SET stock_qty = stock_qty + $1
         WHERE product_id = $2 AND size = $3 AND color IS NOT DISTINCT FROM $4`,
        [item.quantity, item.product_id, item.size, item.color]
      );
    }

    const result = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      ['Cancelled', id]
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