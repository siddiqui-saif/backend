const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { upload } = require('../config/cloudinary');

const EXCHANGE_WINDOW_DAYS = 3;

function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'EXCH-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Naya exchange request banana - PUBLIC
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { order_id, order_item_id, desired_size, desired_color, reason, note } = req.body;

    if (!order_id || !order_item_id || !desired_size || !reason) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Order aur item ki asal detail database se nikalna (client pe bharosa nahi karte)
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];

    const itemResult = await pool.query(
      'SELECT * FROM order_items WHERE id = $1 AND order_id = $2',
      [order_item_id, order_id]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order item not found' });
    }
    const item = itemResult.rows[0];

    // Eligibility check: Delivered hona chahiye, aur time window ke andar
    if (order.status !== 'Delivered') {
      return res.status(400).json({ error: 'This order is not eligible for exchange yet.' });
    }
    if (order.delivered_at) {
      const daysSinceDelivery = (Date.now() - new Date(order.delivered_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceDelivery > EXCHANGE_WINDOW_DAYS) {
        return res.status(400).json({ error: `The exchange window (${EXCHANGE_WINDOW_DAYS} days) for this order has closed.` });
      }
    }

    // Ek item ke liye ek hi active request honi chahiye
    const existingResult = await pool.query(
      `SELECT id FROM exchange_requests WHERE order_item_id = $1 AND status NOT IN ('Rejected')`,
      [order_item_id]
    );
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'An exchange request already exists for this item.' });
    }

    const photoUrl = req.file ? req.file.path : null;

    let trackingCode;
    let inserted = false;
    let newRequest;
    let attempts = 0;

    while (!inserted && attempts < 5) {
      trackingCode = generateTrackingCode();
      try {
        const result = await pool.query(
          `INSERT INTO exchange_requests
           (order_id, order_item_id, customer_name, phone, current_size, current_color, desired_size, desired_color, reason, note, tracking_code, photo_url, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Requested') RETURNING *`,
          [order_id, order_item_id, order.customer_name, order.phone, item.size, item.color, desired_size, desired_color || null, reason, note || null, trackingCode, photoUrl]
        );
        newRequest = result.rows[0];
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

    res.json(newRequest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer: exchange status track karna - PUBLIC
router.get('/track/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const result = await pool.query(
      `SELECT er.*, p.name as product_name
       FROM exchange_requests er
       LEFT JOIN order_items oi ON er.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE er.tracking_code = $1`,
      [code.toUpperCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No exchange request found with this tracking code.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: sab exchange requests dekhna - PROTECTED
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT er.*, p.name as product_name, o.id as order_number
       FROM exchange_requests er
       LEFT JOIN order_items oi ON er.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       LEFT JOIN orders o ON er.order_id = o.id
       ORDER BY er.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: status update karna - PROTECTED
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_note } = req.body;
    const result = await pool.query(
      'UPDATE exchange_requests SET status = $1, admin_note = COALESCE($2, admin_note) WHERE id = $3 RETURNING *',
      [status, admin_note, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exchange request not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: courier/pickup details add karna - PROTECTED
router.patch('/:id/courier', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { courier_name, courier_tracking_number } = req.body;

    const result = await pool.query(
      `UPDATE exchange_requests SET courier_name = $1, courier_tracking_number = $2, status = 'Pickup Scheduled'
       WHERE id = $3 RETURNING *`,
      [courier_name, courier_tracking_number, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exchange request not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: delete karna - PROTECTED
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM exchange_requests WHERE id = $1', [id]);
    res.json({ message: 'Exchange request deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;