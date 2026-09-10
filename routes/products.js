const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/auth');
const { cloudinary, upload } = require('../config/cloudinary');

// Sab active products dikhana - PUBLIC (city/category/size filter ke sath)
router.get('/', async (req, res) => {
  try {
    const { category, size } = req.query;

    let query = 'SELECT * FROM products WHERE is_active = true';
    const params = [];

    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }

    query += ' ORDER BY id';

    const productsResult = await pool.query(query, params);
    let products = productsResult.rows;

    for (let product of products) {
      const sizesResult = await pool.query(
        'SELECT size, color, stock_qty FROM product_sizes WHERE product_id = $1',
        [product.id]
      );
      product.sizes = sizesResult.rows;

      const imagesResult = await pool.query(
        'SELECT id, image_url, color FROM product_images WHERE product_id = $1 ORDER BY id',
        [product.id]
      );
      product.images = imagesResult.rows;
    }

    if (size) {
      products = products.filter(p =>
        p.sizes.some(s => s.size === size && s.stock_qty > 0)
      );
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin ke liye: sab products dikhana (active + inactive, factory ke naam ke sath) - PROTECTED
router.get('/admin/all', verifyAdmin, async (req, res) => {
  try {
    const productsResult = await pool.query(
      `SELECT p.*, f.name as factory_name, f.city as factory_city
       FROM products p
       LEFT JOIN factories f ON p.factory_id = f.id
       ORDER BY p.id DESC`
    );
    const products = productsResult.rows;

    for (let product of products) {
      const sizesResult = await pool.query(
        'SELECT id, size, color, stock_qty FROM product_sizes WHERE product_id = $1',
        [product.id]
      );
      product.sizes = sizesResult.rows;

      const imagesResult = await pool.query(
        'SELECT id, image_url, color FROM product_images WHERE product_id = $1 ORDER BY id',
        [product.id]
      );
      product.images = imagesResult.rows;
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek product ki poori detail - PUBLIC
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const product = productResult.rows[0];

    const sizesResult = await pool.query(
      'SELECT id, size, color, stock_qty FROM product_sizes WHERE product_id = $1',
      [id]
    );
    product.sizes = sizesResult.rows;

    const imagesResult = await pool.query(
      'SELECT id, image_url, color FROM product_images WHERE product_id = $1 ORDER BY id',
      [id]
    );
    product.images = imagesResult.rows;

    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Naya product add karna - PROTECTED
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const { factory_id, name, category, price, description, sizes } = req.body;

    const productResult = await pool.query(
      'INSERT INTO products (factory_id, name, category, price, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [factory_id, name, category, price, description]
    );
    const newProduct = productResult.rows[0];

    if (sizes && sizes.length > 0) {
      for (let s of sizes) {
        await pool.query(
          'INSERT INTO product_sizes (product_id, size, color, stock_qty) VALUES ($1, $2, $3, $4)',
          [newProduct.id, s.size, s.color, s.stock_qty]
        );
      }
    }

    res.json(newProduct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Product edit karna - PROTECTED
router.put('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, price, description } = req.body;

    const result = await pool.query(
      `UPDATE products SET name = $1, category = $2, price = $3, description = $4
       WHERE id = $5 RETURNING *`,
      [name, category, price, description, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock update karna - PROTECTED
router.patch('/:id/stock', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { size, color, stock_qty } = req.body;

    const existing = await pool.query(
      'SELECT * FROM product_sizes WHERE product_id = $1 AND size = $2 AND color IS NOT DISTINCT FROM $3',
      [id, size, color]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        'UPDATE product_sizes SET stock_qty = $1 WHERE product_id = $2 AND size = $3 AND color IS NOT DISTINCT FROM $4 RETURNING *',
        [stock_qty, id, size, color]
      );
    } else {
      result = await pool.query(
        'INSERT INTO product_sizes (product_id, size, color, stock_qty) VALUES ($1, $2, $3, $4) RETURNING *',
        [id, size, color, stock_qty]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Size delete karna - PROTECTED
router.delete('/:id/sizes/:sizeId', verifyAdmin, async (req, res) => {
  try {
    const { sizeId } = req.params;
    await pool.query('DELETE FROM product_sizes WHERE id = $1', [sizeId]);
    res.json({ message: 'Size removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek product deactivate karna - PROTECTED
router.patch('/:id/deactivate', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE products SET is_active = false WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product deactivated', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ek product wapas activate karna - PROTECTED
router.patch('/:id/activate', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE products SET is_active = true WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product activated', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Photo upload karna (color ke sath) - PROTECTED
router.post('/:id/images', verifyAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { color } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const imageUrl = req.file.path;

    const result = await pool.query(
      'INSERT INTO product_images (product_id, image_url, color) VALUES ($1, $2, $3) RETURNING *',
      [id, imageUrl, color || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Photo delete karna - PROTECTED
router.delete('/:productId/images/:imageId', verifyAdmin, async (req, res) => {
  try {
    const { imageId } = req.params;

    const imageResult = await pool.query('SELECT * FROM product_images WHERE id = $1', [imageId]);
    if (imageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    await pool.query('DELETE FROM product_images WHERE id = $1', [imageId]);

    res.json({ message: 'Image deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;