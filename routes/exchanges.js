const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { cloudinary, singleImageUpload } = require('../config/cloudinary');
const { LIMITS, cleanSpaces, validateOptionalText } = require('../utils/validators');

const EXCHANGE_WINDOW_DAYS = 3;
const REASONS = ['Size too small', 'Size too large', 'Wrong item received', 'Defective', 'Other'];
const STATUSES = ['Requested', 'Approved', 'Pickup Scheduled', 'Item Received', 'New Item Shipped', 'Completed', 'Rejected'];

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many exchange requests. Please try again later, or contact us on WhatsApp.' },
});

function generateTrackingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'EXCH-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Request reject ho jaye to upload ki hui photo Cloudinary se bhi hata dete hain
async function discardUpload(req) {
  if (req.file && req.file.filename) {
    try {
      await cloudinary.uploader.destroy(req.file.filename);
    } catch (err) {
      console.error('Could not delete unused upload:', err.message);
    }
  }
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Naya exchange request banana - PUBLIC
router.post('/', createLimiter, singleImageUpload('photo'), async (req, res) => {
  async function reject(status, error, field) {
    await discardUpload(req);
    return res.status(status).json(field ? { error, field } : { error });
  }

  try {
    const body = req.body || {};
    const orderId = parseId(body.order_id);
    const itemId = parseId(body.order_item_id);
    const trackingCode = String(body.tracking_code || '').toUpperCase().trim();
    const desiredSize = cleanSpaces(body.desired_size);
    const desiredColor = cleanSpaces(body.desired_color) || null;
    const reason = String(body.reason || '').trim();
    const note = cleanSpaces(body.note);

    if (!orderId || !itemId || !trackingCode) {
      return reject(400, 'Missing required fields');
    }
    if (!REASONS.includes(reason)) {
      return reject(400, 'Please select a valid reason.', 'reason');
    }
    if (!desiredSize || desiredSize.length > 50) {
      return reject(400, 'Please select the size you want.', 'desiredSize');
    }
    if (desiredColor && desiredColor.length > 50) {
      return reject(400, 'Please select a valid color.', 'desiredColor');
    }
    const noteError = validateOptionalText(note, LIMITS.exchangeNote.max, 'Note');
    if (noteError) {
      return reject(400, noteError, 'note');
    }

    // Order ID ke sath tracking code bhi match hona chahiye (order ID sequential hoti hai, guess ho sakti hai)
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND tracking_code = $2',
      [orderId, trackingCode]
    );
    if (orderResult.rows.length === 0) {
      return reject(404, 'Order not found');
    }
    const order = orderResult.rows[0];

    const itemResult = await pool.query(
      'SELECT * FROM order_items WHERE id = $1 AND order_id = $2',
      [itemId, orderId]
    );
    if (itemResult.rows.length === 0) {
      return reject(404, 'Order item not found');
    }
    const item = itemResult.rows[0];

    if (order.status !== 'Delivered') {
      return reject(400, 'This order is not eligible for exchange yet.');
    }
    if (order.delivered_at) {
      const daysSinceDelivery = (Date.now() - new Date(order.delivered_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceDelivery > EXCHANGE_WINDOW_DAYS) {
        return reject(400, `The exchange window (${EXCHANGE_WINDOW_DAYS} days) for this order has closed.`);
      }
    }

    // Jo size/color maanga hai wo waqai stock mein hona chahiye
    const variantResult = await pool.query(
      `SELECT stock_qty FROM product_sizes
       WHERE product_id = $1 AND size = $2 AND color IS NOT DISTINCT FROM $3`,
      [item.product_id, desiredSize, desiredColor]
    );
    if (variantResult.rows.length === 0 || variantResult.rows[0].stock_qty <= 0) {
      return reject(400, 'The selected size or color is not available right now. Please choose another option.', 'desiredSize');
    }
    if (desiredSize === item.size && (desiredColor || null) === (item.color || null)) {
      return reject(400, 'Please choose a different size or color than the one you received.', 'desiredSize');
    }

    // Ek item ke liye ek hi active request honi chahiye
    const existingResult = await pool.query(
      `SELECT id FROM exchange_requests WHERE order_item_id = $1 AND status NOT IN ('Rejected')`,
      [itemId]
    );
    if (existingResult.rows.length > 0) {
      return reject(400, 'An exchange request already exists for this item.');
    }

    const photoUrl = req.file ? req.file.path : null;

    let inserted = false;
    let newRequest;
    let attempts = 0;

    while (!inserted && attempts < 5) {
      const trackingCodeForExchange = generateTrackingCode();
      try {
        const result = await pool.query(
          `INSERT INTO exchange_requests
           (order_id, order_item_id, customer_name, phone, current_size, current_color, desired_size, desired_color, reason, note, tracking_code, photo_url, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Requested')
           RETURNING id, tracking_code, status, created_at`,
          [orderId, itemId, order.customer_name, order.phone, item.size, item.color, desiredSize, desiredColor, reason, note || null, trackingCodeForExchange, photoUrl]
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
    console.error('Exchange request error:', err);
    await discardUpload(req);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Customer: exchange status track karna - PUBLIC (phone aur naam wapas nahi bheje jate)
router.get('/track/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    if (!/^EXCH-[A-Z0-9]{6}$/.test(code)) {
      return res.status(404).json({ error: 'No exchange request found with this tracking code.' });
    }

    const result = await pool.query(
      `SELECT er.id, er.tracking_code, er.status, er.current_size, er.current_color,
              er.desired_size, er.desired_color, er.reason, er.admin_note,
              er.courier_name, er.courier_tracking_number, er.created_at,
              p.name AS product_name
       FROM exchange_requests er
       LEFT JOIN order_items oi ON er.order_item_id = oi.id
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE er.tracking_code = $1`,
      [code]
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });

    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    let adminNote = null;
    if (req.body.admin_note !== undefined && req.body.admin_note !== null) {
      adminNote = String(req.body.admin_note).trim();
      if (adminNote.length > 500) {
        return res.status(400).json({ error: 'Note must be 500 characters or fewer.' });
      }
    }

    const result = await pool.query(
      'UPDATE exchange_requests SET status = $1, admin_note = COALESCE($2, admin_note) WHERE id = $3 RETURNING *',
      [status, adminNote, id]
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });

    const courierName = String(req.body.courier_name || '').trim();
    const courierRef = String(req.body.courier_tracking_number || '').trim();

    if (!courierName || courierName.length > 100) {
      return res.status(400).json({ error: 'Please select a courier.' });
    }
    if (courierRef.length > 100) {
      return res.status(400).json({ error: 'Reference number must be 100 characters or fewer.' });
    }

    const result = await pool.query(
      `UPDATE exchange_requests SET courier_name = $1, courier_tracking_number = $2, status = 'Pickup Scheduled'
       WHERE id = $3 RETURNING *`,
      [courierName, courierRef || null, id]
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid request id' });

    await pool.query('DELETE FROM exchange_requests WHERE id = $1', [id]);
    res.json({ message: 'Exchange request deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;