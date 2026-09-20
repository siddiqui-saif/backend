// Generic error handler - customer ko safe message dikhata hai, asal error sirf server logs mein
function handleError(err, res, fallbackMessage = 'Something went wrong. Please try again.') {
  console.error('Server error:', err); // Asal error sirf terminal/logs mein dikhega

  // Agar ye ek "expected" error hai (jaise "Out of stock"), uska message customer ko dikhana theek hai
  // Agar ye "unexpected" hai (jaise database crash), generic message dikhayenge
  const isDatabaseError = err.code && err.code.length === 5; // PostgreSQL error codes 5-digit hote hain

  if (isDatabaseError) {
    return res.status(500).json({ error: fallbackMessage });
  }

  // Normal application errors (jo humne khud throw kiye, jaise "Out of stock") customer ko dikha sakte hain
  return res.status(500).json({ error: err.message || fallbackMessage });
}

module.exports = { handleError };