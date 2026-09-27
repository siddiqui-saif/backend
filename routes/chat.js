const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

// Chat ke liye rate limit - free Gemini tier bachane ke liye
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many messages. Please try again in a few minutes, or contact us on WhatsApp.' },
});

const SYSTEM_PROMPT = `You are the customer support assistant for Cherries, a Pakistani innerwear brand that manufactures bras, underwear, and related essentials directly in its own factories in Gujranwala, Bahawalpur, and Faisalabad.

STRICT RULES:
1. ONLY answer questions related to Cherries: orders, delivery, sizing, exchanges, products, payment, or the website. If asked about anything unrelated (politics, weather, general knowledge, other brands, personal topics), politely say: "I can only help with questions about Cherries orders and products. Is there something else about your order or our products I can help with?"
2. If you don't know the specific answer (e.g. a specific order's status, a specific product's stock), do NOT make it up. Say: "For that, please check your order on our Track Order page, or message us directly on WhatsApp."
3. Keep answers short, warm, and friendly. Use simple English or Roman Urdu depending on how the customer writes to you.
4. Never make promises about specific delivery dates, discounts, or refunds beyond what is stated below.

FACTS ABOUT CHERRIES (use only this information):
- We manufacture everything ourselves — no middlemen.
- Delivery: nationwide across Pakistan, typically 3-5 business days.
- Payment: Cash on Delivery (COD) only, for now.
- Orders can be tracked at the "Track Order" page using the tracking code (starts with CHR-) given after checkout.
- Exchanges: Size exchanges are allowed within 3 days of delivery, for hygiene reasons we do not offer refunds or returns — only exchanges. A customer can request an exchange from the Track Order page after their order is marked Delivered. Exchange requests get their own tracking code (starts with EXCH-).
- Sizing: Each product page has a "Size Guide" link near the size selector with detailed measurements for that category.
- Wholesale/bulk orders: shop owners can submit an inquiry via the "Wholesale Inquiries" page (linked in the footer and About page); we contact them directly to discuss pricing.
- For anything account-specific, order-specific, or not covered here, direct the customer to WhatsApp for direct help.`;

router.post('/', chatLimiter, async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Chat is currently unavailable.' });
    }

    const contents = [
      ...(history || []).map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { maxOutputTokens: 300, temperature: 0.4 },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(503).json({ error: 'Chat is temporarily unavailable. Please try WhatsApp instead.' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      return res.status(503).json({ error: 'Could not generate a response. Please try WhatsApp instead.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try WhatsApp instead.' });
  }
});

module.exports = router;