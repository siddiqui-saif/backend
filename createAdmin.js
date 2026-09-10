require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./config/db');

async function createAdmin() {
  const username = 'admin'; // Apna admin username yahan likh sakte hain
  const plainPassword = 'BraStore2026'; // Apna asal password yahan likhein

  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  try {
    const result = await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hashedPassword]
    );
    console.log('Admin ban gaya:', result.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

createAdmin();