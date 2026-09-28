const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');

// ---------- Thresholds (yahan se badal sakte hain) ----------
const HIGH_VALUE_AMOUNT = 8000;      // naye phone ka itna bara order risky maana jata hai (Rs)
const SHORT_ADDRESS_LENGTH = 20;     // isse chhota address risky maana jata hai
const RAPID_WINDOW_HOURS = 24;       // itne ghante mein kai orders = risky
const SHARED_ADDRESS_DAYS = 30;      // ek address pe alag phones dekhne ka daura
const MAX_IDS = 300;

const STRONG_BAD_REASONS = ['Refused at delivery', 'Unreachable', 'Fake order'];

// Phone ki aakhri 10 digits: 0300..., +92 300..., 92300... sab ek jaise ban jate hain
const PHONE_KEY_SQL = "right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)";
const ADDRESS_KEY_SQL = "btrim(lower(regexp_replace(COALESCE(address, ''), '[[:space:]]+', ' ', 'g')))";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function computeRisk(order, byPhone, byAddress) {
  let score = 0;
  const reasons = [];
  const created = new Date(order.created_at).getTime();
  const phoneKnown = order.phone_key && order.phone_key.length === 10;

  const otherPhoneOrders = phoneKnown
    ? (byPhone.get(order.phone_key) || []).filter((o) => o.id !== order.id)
    : [];
  const earlier = otherPhoneOrders.filter((o) => new Date(o.created_at).getTime() < created);

  const strongBad = earlier.filter(
    (o) => o.status === 'Cancelled' && STRONG_BAD_REASONS.includes(o.cancel_reason)
  );
  const shippedThenCancelled = earlier.filter(
    (o) => o.status === 'Cancelled' && !o.cancel_reason && (o.courier_name || o.tracking_number)
  );
  const delivered = earlier.filter((o) => o.status === 'Delivered');

  // 1. Pehle ka bura record
  if (strongBad.length >= 2) {
    score += 5;
    reasons.push({
      tone: 'bad',
      text: plural(strongBad.length, 'earlier order') + ' from this phone number were refused, unreachable or fake.',
    });
  } else if (strongBad.length === 1) {
    score += 3;
    reasons.push({
      tone: 'bad',
      text: 'An earlier order from this phone number was marked "' + strongBad[0].cancel_reason + '".',
    });
  }

  if (shippedThenCancelled.length > 0) {
    score += 1;
    reasons.push({
      tone: 'bad',
      text: plural(shippedThenCancelled.length, 'earlier order') + ' from this phone number ' +
        (shippedThenCancelled.length === 1 ? 'was' : 'were') + ' shipped and then cancelled.',
    });
  }

  // 2. Naya customer
  if (phoneKnown && earlier.length === 0) {
    if (parseFloat(order.total_amount) >= HIGH_VALUE_AMOUNT) {
      score += 2;
      reasons.push({
        tone: 'bad',
        text: 'New phone number with a high-value order (Rs ' + parseFloat(order.total_amount).toLocaleString() + ').',
      });
    } else {
      reasons.push({ tone: 'info', text: 'First order from this phone number.' });
    }
  }

  // 3. Thore waqt mein kai orders
  if (phoneKnown) {
    const rapid = otherPhoneOrders.filter(
      (o) =>
        o.status !== 'Cancelled' &&
        Math.abs(new Date(o.created_at).getTime() - created) <= RAPID_WINDOW_HOURS * HOUR_MS
    );
    if (rapid.length >= 2) {
      score += 2;
      reasons.push({
        tone: 'bad',
        text: 'This phone number placed ' + plural(rapid.length + 1, 'order') + ' within ' + RAPID_WINDOW_HOURS + ' hours.',
      });
    }
  }

  // 4. Ek address, kai alag phones
  if (order.address_key && order.address_key.length >= 15) {
    const otherPhones = new Set();
    for (const o of byAddress.get(order.address_key) || []) {
      if (o.id === order.id || o.phone_key === order.phone_key || !o.phone_key) continue;
      if (Math.abs(new Date(o.created_at).getTime() - created) <= SHARED_ADDRESS_DAYS * DAY_MS) {
        otherPhones.add(o.phone_key);
      }
    }
    if (otherPhones.size >= 2) {
      score += 2;
      reasons.push({
        tone: 'bad',
        text: 'The same address was used with ' + plural(otherPhones.size, 'other phone number') + ' in the last ' + SHARED_ADDRESS_DAYS + ' days.',
      });
    }
  }

  // 5. Chhota address
  if (String(order.address || '').trim().length < SHORT_ADDRESS_LENGTH) {
    score += 1;
    reasons.push({ tone: 'bad', text: 'The address is very short. Check that it is complete.' });
  }

  // 6. Achi history
  if (delivered.length > 0) {
    score -= 2;
    reasons.push({
      tone: 'good',
      text: plural(delivered.length, 'earlier order') + ' from this phone number ' +
        (delivered.length === 1 ? 'was' : 'were') + ' delivered successfully.',
    });
  }

  score = Math.max(0, score);
  let level = score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low';
  if (strongBad.length > 0 && level === 'Low') level = 'Medium';

  const order_rank = { bad: 0, info: 1, good: 2 };
  reasons.sort((a, b) => order_rank[a.tone] - order_rank[b.tone]);

  return {
    level,
    score,
    reasons,
    history: {
      previous_orders: earlier.length,
      delivered: delivered.length,
      bad_outcomes: strongBad.length + shippedThenCancelled.length,
    },
  };
}

// Risk dekhna: GET /api/order-risk?ids=1,2,3 - PROTECTED
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    const unique = [...new Set(ids)].slice(0, MAX_IDS);

    if (unique.length === 0) {
      return res.json({});
    }

    const selected = await pool.query(
      `SELECT id, status, total_amount, created_at, address,
              ${PHONE_KEY_SQL} AS phone_key,
              ${ADDRESS_KEY_SQL} AS address_key
       FROM orders
       WHERE id = ANY($1::int[])`,
      [unique]
    );

    const phoneKeys = [...new Set(selected.rows.map((o) => o.phone_key).filter((k) => k && k.length === 10))];
    const addressKeys = [...new Set(selected.rows.map((o) => o.address_key).filter((k) => k && k.length >= 15))];

    const byPhone = new Map();
    if (phoneKeys.length > 0) {
      const history = await pool.query(
        `SELECT id, status, cancel_reason, courier_name, tracking_number, created_at,
                ${PHONE_KEY_SQL} AS phone_key
         FROM orders
         WHERE ${PHONE_KEY_SQL} = ANY($1::text[])`,
        [phoneKeys]
      );
      for (const row of history.rows) {
        if (!byPhone.has(row.phone_key)) byPhone.set(row.phone_key, []);
        byPhone.get(row.phone_key).push(row);
      }
    }

    const byAddress = new Map();
    if (addressKeys.length > 0) {
      const shared = await pool.query(
        `SELECT id, created_at,
                ${PHONE_KEY_SQL} AS phone_key,
                ${ADDRESS_KEY_SQL} AS address_key
         FROM orders
         WHERE ${ADDRESS_KEY_SQL} = ANY($1::text[])`,
        [addressKeys]
      );
      for (const row of shared.rows) {
        if (!byAddress.has(row.address_key)) byAddress.set(row.address_key, []);
        byAddress.get(row.address_key).push(row);
      }
    }

    const result = {};
    for (const order of selected.rows) {
      result[order.id] = computeRisk(order, byPhone, byAddress);
    }

    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    console.error('Order risk error:', err);
    res.status(500).json({ error: 'Could not calculate order risk.' });
  }
});

module.exports = router;