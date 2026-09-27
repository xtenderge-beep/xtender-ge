const pool = require('../config/db');

async function index(req, res) {
  const cities = (await pool.query('SELECT * FROM cities ORDER BY sort_order,id')).rows;
  res.render('admin/cities', { cities, error: req.query.error || null });
}

async function create(req, res) {
  const slug = String(req.body.slug || '').trim().toLowerCase();
  const names = ['nameKa', 'nameRu', 'nameEn'].map(key => String(req.body[key] || '').trim());
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(slug) || names.some(name => !name || name.length > 100)) {
    return res.redirect('/admin/cities?error=invalid');
  }
  try {
    await pool.query('INSERT INTO cities(slug,name_ka,name_ru,name_en,is_active) VALUES($1,$2,$3,$4,false)', [slug,...names]);
  } catch (error) {
    if (error.code === '23505') return res.redirect('/admin/cities?error=duplicate');
    throw error;
  }
  res.redirect('/admin/cities');
}

async function setStatus(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send('Некорректный город');
  const enabled = req.body.enabled === '1';
  if (!enabled) {
    const used = await pool.query('SELECT id FROM master_cities WHERE city_id=$1 LIMIT 1', [id]);
    if (used.rows.length) return res.redirect('/admin/cities?error=in_use');
    const orders = await pool.query("SELECT id FROM orders WHERE city_id=$1 AND status IN ('new','pending_review') LIMIT 1", [id]);
    if (orders.rows.length) return res.redirect('/admin/cities?error=in_use');
  }
  await pool.query('UPDATE cities SET is_active=$2 WHERE id=$1', [id,enabled]);
  res.redirect('/admin/cities');
}

module.exports = { index, create, setStatus };
