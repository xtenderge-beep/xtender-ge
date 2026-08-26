require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api.routes');
const orderController = require('./controllers/order.controller');
const masterService = require('./services/master.service');
const { normalizeLang, translate, clientStrings } = require('./config/i18n');
const asyncHandler = require('./middleware/asyncHandler');
const pool = require('./config/db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  req.lang = normalizeLang(req.cookies.lang);
  res.locals.lang = req.lang;
  res.locals.t = translate(req.lang);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/lang/:code', (req, res) => {
  const lang = normalizeLang(req.params.code);
  res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  const back = req.get('Referer') || '/';
  res.redirect(back);
});

app.get('/', asyncHandler(async (req, res) => {
  const masters = await masterService.listMasters();
  res.render('index', { masters, clientStrings: clientStrings(req.lang) });
}));

app.get('/join', (req, res) => {
  res.render('join', { clientStrings: clientStrings(req.lang) });
});

app.get('/terms', (req, res) => {
  res.render('terms');
});

app.get('/order/:token', asyncHandler(orderController.show));
app.get('/o/:ownerToken', asyncHandler(orderController.showByOwnerToken));
app.get('/my-orders', asyncHandler(orderController.myOrders));

app.get('/master/:token', asyncHandler(async (req, res) => {
  const master = await masterService.getMasterByToken(req.params.token);
  res.render('master-status', { master, clientStrings: clientStrings(req.lang) });
}));

app.use('/api', apiRoutes);

app.use((err, req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message === 'Unsupported file type')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  console.error('Unhandled request error:', err);
  if (req.path.startsWith('/api')) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
  return res.status(500).send('Internal server error');
});

const PORT = process.env.PORT || 3000;

async function runMigrations() {
  if (process.env.SKIP_DB_MIGRATIONS) return;
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema is up to date');
}

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Xtender server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run database migrations:', err);
    process.exit(1);
  });
