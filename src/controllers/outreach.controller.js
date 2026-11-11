// Админка «Рассылки» (/admin/outreach): черновик, пробное SMS, отправка и итог по каждому исполнителю.
const outreach = require('../services/outreach.service');

const DEFAULT_SMS = 'Xtender: you have a message from support. Log in and reply: https://xtender.ge/master#support';
const flash = (req) => ({ error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null,
  notice: typeof req.query.notice === 'string' ? req.query.notice.slice(0, 300) : null });
const back = (id, key, text) => `/admin/outreach/${id}?${key}=${encodeURIComponent(text)}`;
const campaignId = (req) => parseInt(req.params.id, 10);

async function index(req, res) {
  res.render('admin/outreach', { campaigns: await outreach.list() });
}

async function form(req, res) {
  res.render('admin/outreach-new', { error: null, input: { title: '', smsText: DEFAULT_SMS, recipients: '' } });
}

async function create(req, res) {
  const input = { title: req.body.title, smsText: req.body.smsText, recipients: req.body.recipients };
  try {
    const campaign = await outreach.create(input);
    res.redirect('/admin/outreach/' + campaign.id);
  } catch (error) {
    if (!error.status) throw error;
    res.status(error.status).render('admin/outreach-new', { error: error.message, input });
  }
}

async function show(req, res) {
  const data = await outreach.get(campaignId(req));
  if (!data) return res.status(404).send('Рассылка не найдена');
  const filter = ['seen', 'unseen', 'replied', 'waiting', 'failed'].includes(req.query.show) ? req.query.show : 'all';
  res.render('admin/outreach-detail', { ...data, filter, ...flash(req) });
}

// Общая обёртка действий формы: ошибка из сервиса — сообщением на той же странице.
const action = (fn, notice) => async (req, res) => {
  const id = campaignId(req);
  try {
    const result = await fn(req, id);
    res.redirect(back(id, 'notice', typeof notice === 'function' ? notice(result) : notice) + (req.body.anchor ? '#' + String(req.body.anchor).replace(/[^\w-]/g, '') : ''));
  } catch (error) {
    if (!error.status) throw error;
    res.redirect(back(id, 'error', error.message));
  }
};

const updateBody = action((req, id) => outreach.updateBody(id, parseInt(req.params.itemId, 10), req.body.body), 'Текст сохранён.');
const skip = action((req, id) => outreach.setSkipped(id, parseInt(req.params.itemId, 10), req.body.skipped !== '0'),
  () => 'Список получателей обновлён.');
const updateSms = action((req, id) => outreach.updateSms(id, req.body.smsText), 'Текст SMS сохранён.');
const sendTest = action((req, id) => outreach.sendTest(id, req.body.phone), number => `Пробное SMS отправлено на ${number}.`);
const send = action(async (req, id) => {
  if (req.body.confirm !== 'yes') throw Object.assign(new Error('Отметьте «Проверил тексты и пробное SMS».'), { status: 400 });
  const run = await outreach.start(id);
  run.done.catch(err => console.error('[outreach] run failed', id, err.message));
  return run.count;
}, count => `Рассылка запущена: ${count} получателей. Статусы обновляются по мере отправки — обновите страницу.`);

module.exports = { index, form, create, show, updateBody, skip, updateSms, sendTest, send, DEFAULT_SMS };
