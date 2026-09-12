require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const factoriesRoute = require('./routes/factories');
const productsRoute = require('./routes/products');
const ordersRoute = require('./routes/orders');
const adminRoute = require('./routes/admin');
const customersRoute = require('./routes/customers');
const reviewsRoute = require('./routes/reviews');
const settingsRoute = require('./routes/settings');
const couponsRoute = require('./routes/coupons');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/factories', factoriesRoute);
app.use('/api/products', productsRoute);
app.use('/api/orders', ordersRoute);
app.use('/api/admin', adminRoute);
app.use('/api/customers', customersRoute);
app.use('/api/reviews', reviewsRoute);
app.use('/api/settings', settingsRoute);
app.use('/api/coupons', couponsRoute);

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ message: 'Database connected!', time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});