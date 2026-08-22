require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const apiRoutes = require('./routes/api.routes');
const orderController = require('./controllers/order.controller');
const masterService = require('./services/master.service');
const { normalizeLang, translate, clientStrings } = require('./config/i18n');

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

app.get('/', async (req, res) => {
  const masters = await masterService.listMasters();
  res.render('index', { masters, clientStrings: clientStrings(req.lang) });
});

app.get('/order/:token', orderController.show);

app.use('/api', apiRoutes);

app.use((err, req, res, next) => {
  if (err && (err.name === 'MulterError' || err.message === 'Unsupported file type')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Xtender server running on port ${PORT}`);
});
