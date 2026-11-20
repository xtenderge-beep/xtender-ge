// Админка «Компании для обзвона» (/admin/outreach/prospects): список, карточка, итог звонка, ссылка на анкету.
const prospects = require('../services/prospect.service');
const drafts = require('../services/providerDraft.service');
const { requestMeta } = require('../config/requestMeta');

const STAGES = ['new', 'no_answer', 'callback', 'agreed', 'link_sent', 'link_opened', 'link_expired', 'registered', 'declined', 'refused', 'do_not_call', 'rejected'];
const STAGE_LABELS = {
  new: 'Не звонили', no_answer: 'Не дозвонился', callback: 'Перезвонить', agreed: 'Согласился', link_sent: 'Ссылка отправлена',
  link_opened: 'Открыл ссылку', link_expired: 'Ссылка истекла', registered: 'Подтвердил — исполнитель', declined: 'Отказался по телефону',
  refused: 'Нажал «Не интересно»', do_not_call: 'Просил не звонить', rejected: 'Отклонён модератором',
};
const RESULT_LABELS = { no_answer: 'Не дозвонился', callback: 'Перезвонить', declined: 'Отказался', do_not_call: 'Просил не звонить', note: 'Заметка', agreed: 'Согласился' };

const id = req => parseInt(req.params.id, 10);
const back = (prospectId, key, text) => `/admin/outreach/prospects/${prospectId}?${key}=${encodeURIComponent(text)}`;

// Готовый текст сообщения со ссылкой — владелец отправляет его со своего телефона (WhatsApp или SMS).
function messageText(name, url) {
  return {
    ka: `გამარჯობა! როგორც ტელეფონით შევთანხმდით, xtender.ge-ზე მოგიმზადეთ ანკეტა „${name}“: ${url}\nშეამოწმეთ, საჭიროების შემთხვევაში შეასწორეთ და დაადასტურეთ SMS-კოდით. პირველი 2 თვე უფასოა.`,
    ru: `Здравствуйте! Как договорились по телефону, мы подготовили анкету «${name}» на xtender.ge: ${url}\nПроверьте, при необходимости исправьте и подтвердите кодом из SMS. Первые 2 месяца бесплатно.`,
  };
}

async function index(req, res) {
  const stage = STAGES.includes(req.query.stage) ? req.query.stage : '';
  const service = typeof req.query.service === 'string' ? req.query.service.slice(0, 100) : '';
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const data = await prospects.list({ stage, service, q });
  res.render('admin/outreach-prospects', { ...data, filter: { stage, service, q }, stages: STAGES, labels: STAGE_LABELS, services: await drafts.services() });
}

async function show(req, res) {
  const row = await prospects.get(id(req));
  if (!row) return res.status(404).send('Не найдено');
  const flash = { error: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null, notice: typeof req.query.notice === 'string' ? req.query.notice.slice(0, 300) : null };
  res.set('Cache-Control', 'no-store');
  res.render('admin/outreach-prospect', { p: row, labels: STAGE_LABELS, results: RESULT_LABELS, flash, message: row.confirmUrl ? messageText(row.name, row.confirmUrl) : null });
}

async function call(req, res) {
  try {
    await prospects.logCall(id(req), { result: req.body.result, note: req.body.note || '' }, requestMeta(req));
    res.redirect(back(id(req), 'notice', 'Записано'));
  } catch (error) {
    if (!error.status) throw error;
    res.redirect(back(id(req), 'error', error.message));
  }
}

async function note(req, res) {
  await prospects.setNote(id(req), req.body.note || '');
  res.redirect(back(id(req), 'notice', 'Заметка сохранена'));
}

async function link(req, res) {
  try {
    const result = await prospects.createLink(id(req), { lang: req.body.lang, confirmedByOwner: req.body.agreed === 'yes' }, requestMeta(req));
    res.redirect(back(id(req), 'notice', result.created ? 'Ссылка создана — отправьте её компании' : 'Это та же ссылка, что и раньше'));
  } catch (error) {
    if (!error.status) throw error;
    const text = { already_registered: 'Этот номер уже зарегистрирован как исполнитель.', opted_out: 'Номер в списке отказа: компания просила не писать.' }[error.code] || error.message;
    res.redirect(back(id(req), 'error', text));
  }
}

async function remove(req, res) {
  if (req.body.confirm !== 'yes') return res.redirect(back(id(req), 'error', 'Отметьте, что удалить'));
  await prospects.remove(id(req));
  res.redirect('/admin/outreach/prospects');
}

module.exports = { index, show, call, note, link, remove, STAGE_LABELS };
