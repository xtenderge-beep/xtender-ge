// Компании для обзвона (docs/outreach-prospects.md). Владелец загружает список компаний из поиска (API с ключом бота),
// в админке видит карточку — номер, сайт, услуги, где нашли — звонит сам и записывает итог звонка. Если компания
// согласилась по телефону, из карточки создаётся обычный черновик анкеты (providerDraft.service.create) и ссылка
// /c/<token>, которую владелец отправляет со своего телефона (WhatsApp или SMS). Дальше всё как у анкет от бота:
// компания проверяет анкету, сама ставит галочки (оферта, политика, SMS о заявках) и подтверждает кодом из SMS сайта —
// это и есть её согласие в журнале. Сайт компаниям из списка ничего не отправляет и нигде их не показывает.
const pool = require('../config/db');
const drafts = require('./providerDraft.service');

const RESULTS = ['no_answer', 'callback', 'declined', 'do_not_call', 'note'];
const STATUSES = ['new', 'no_answer', 'callback', 'agreed', 'declined', 'do_not_call'];
const LIMITS = { name: 120, phonesExtra: 200, website: 300, email: 200, title: 300, description: 4000, foundWhere: 500, note: 1000, source: 80, item: 100, items: 20, batch: 500 };

const ALIASES = { transport: 'van', truck: 'van', loaders: 'movers', waste: 'junk' };
const fail = drafts.fail;
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const json = drafts.json;

function website(raw) {
  const value = clip(raw, LIMITS.website);
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
    return `https://${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '')}`.slice(0, LIMITS.website);
  } catch (_) { return null; }
}

function items(value) {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return [...new Set(list.filter(v => typeof v === 'string').map(v => clip(v, LIMITS.item)).filter(Boolean))].slice(0, LIMITS.items);
}

// Первый грузинский номер — основной (на него пойдёт ссылка), остальные — для справки.
function phones(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\n]/)).map(v => drafts.normalizePhone(String(v).trim())).filter(Boolean);
  return [...new Set(list)];
}

// Без номеров в описании: черновик анкеты их не принимает (номер клиенты открывают через каталог).
const stripPhones = text => String(text || '').replace(/\+?\d[\d\s\-().]{6,}\d/g, ' ').replace(/\s+/g, ' ').trim();

// Загрузка списка (API с ключом бота). Повтор с тем же номером или сайтом обновляет карточку, не трогая итоги звонков.
async function importMany(list, { source = '' } = {}) {
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.batch) throw fail('invalid_request', `Send "prospects": a list of 1–${LIMITS.batch} companies.`);
  source = clip(source, LIMITS.source);
  if (source && !/^[A-Za-z0-9_.:-]+$/.test(source)) throw fail('invalid_field', 'Field "source" may contain only Latin letters, digits and _ . : -', 400, { field: 'source' });
  const known = new Set((await drafts.services()).map(s => s.code));
  const result = { created: 0, updated: 0, skipped: [] };
  for (const [index, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object') { result.skipped.push({ index, reason: 'not_an_object' }); continue; }
    const name = clip(raw.name, LIMITS.name);
    const [phone, ...extra] = phones(raw.phones ?? raw.phone);
    const site = website(raw.website);
    if (!name || (!phone && !site)) { result.skipped.push({ index, name, reason: 'need_name_and_phone_or_website' }); continue; }
    // Синонимы кодов из выгрузок: transport — это «Перевозки» (van) на сайте.
    const asked = items(raw.services).map(code => ALIASES[code] || code);
    const row = {
      name, phone: phone || null, phones_extra: extra.join(', ').slice(0, LIMITS.phonesExtra), website: site,
      email: clip(raw.email, LIMITS.email), title: clip(raw.title, LIMITS.title), description: clip(raw.description, LIMITS.description),
      services: asked.filter(code => known.has(code)),
      // Код, которого нет на сайте, сохраняем текстом — модератор увидит его в анкете.
      other_services: [...new Set([...items(raw.other_services), ...asked.filter(code => !known.has(code))])].slice(0, LIMITS.items),
      found_where: clip(raw.found_where, LIMITS.foundWhere), note: clip(raw.note, LIMITS.note), source: source || clip(raw.source, LIMITS.source),
    };
    const existing = (await pool.query('SELECT id FROM outreach_prospects WHERE ($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND website = $2) ORDER BY id LIMIT 1',
      [row.phone, row.website])).rows[0];
    const values = [row.name, row.phone, row.phones_extra, row.website, row.email, row.title, row.description, JSON.stringify(row.services),
      JSON.stringify(row.other_services), row.found_where, row.note, row.source];
    if (existing) {
      await pool.query(`UPDATE outreach_prospects SET name = $1, phone = COALESCE($2, phone), phones_extra = $3, website = COALESCE($4, website), email = $5, title = $6,
        description = $7, services = $8::jsonb, other_services = $9::jsonb, found_where = $10, note = CASE WHEN note = '' THEN $11 ELSE note END,
        source = CASE WHEN $12 = '' THEN source ELSE $12 END, updated_at = NOW() WHERE id = $13`, [...values, existing.id]);
      result.updated++;
    } else {
      await pool.query(`INSERT INTO outreach_prospects (name, phone, phones_extra, website, email, title, description, services, other_services, found_where, note, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`, values);
      result.created++;
    }
  }
  return result;
}

// Что сейчас с номером на сайте: уже исполнитель, отказ, черновик анкеты — это важнее записанного итога звонка.
async function live(row) {
  if (!row.phone) return { stage: row.status, site: null };
  const site = await drafts.status(row.phone);
  let stage = row.status;
  if (['active', 'confirmed'].includes(site.status)) stage = 'registered';
  else if (site.status === 'rejected') stage = 'rejected';
  else if (['declined', 'opted_out'].includes(site.status)) stage = row.status === 'do_not_call' ? 'do_not_call' : 'refused';
  else if (['draft', 'opened'].includes(site.status)) stage = site.status === 'opened' ? 'link_opened' : 'link_sent';
  else if (site.status === 'expired' && row.status === 'agreed') stage = 'link_expired';
  return { stage, site };
}

function shape(row) {
  return { ...row, services: json(row.services, []), other_services: json(row.other_services, []), calls: json(row.calls, []) };
}

async function list({ stage = '', service = '', q = '' } = {}) {
  await drafts.expireOld();
  const rows = (await pool.query('SELECT * FROM outreach_prospects ORDER BY id')).rows.map(shape);
  const out = [];
  for (const row of rows) out.push({ ...row, ...(await live(row)) });
  const counts = {};
  for (const row of out) counts[row.stage] = (counts[row.stage] || 0) + 1;
  const needle = clip(q, 100).toLowerCase();
  const shown = out.filter(r => (!stage || r.stage === stage) && (!service || r.services.includes(service) || r.other_services.includes(service))
    && (!needle || [r.name, r.phone, r.website, r.title, r.note].some(v => String(v || '').toLowerCase().includes(needle))));
  return { rows: shown, counts, total: out.length };
}

async function get(id) {
  const row = (await pool.query('SELECT * FROM outreach_prospects WHERE id = $1', [id])).rows[0];
  if (!row) return null;
  const shaped = shape(row);
  const state = await live(shaped);
  const draft = shaped.phone ? (await pool.query('SELECT * FROM provider_drafts WHERE phone = $1', [shaped.phone])).rows[0] : null;
  return { ...shaped, ...state, confirmUrl: draft && drafts.draftStatus(draft) !== 'expired' && draft.status === 'draft' ? drafts.confirmUrl(draft.token) : null,
    expiresAt: draft?.status === 'draft' ? draft.expires_at : null };
}

function pushCall(row, entry) {
  return JSON.stringify([...json(row.calls, []), { at: new Date().toISOString(), ...entry }].slice(-200));
}

// Итог звонка владельца. «Просил не звонить» — номер уходит в общий список отказа (анкеты от бота его тоже не тронут).
async function logCall(id, { result, note = '' }, meta = {}) {
  if (!RESULTS.includes(result)) throw fail('invalid_field', 'Unknown call result.', 400, { field: 'result' });
  const row = (await pool.query('SELECT * FROM outreach_prospects WHERE id = $1', [id])).rows[0];
  if (!row) throw fail('not_found', 'Not found.', 404);
  note = clip(note, LIMITS.note);
  const status = result === 'note' ? row.status : result;
  await pool.query('UPDATE outreach_prospects SET status = $2, calls = $3::jsonb, updated_at = NOW() WHERE id = $1',
    [id, status, pushCall(row, { result, note })]);
  if (result === 'do_not_call' && row.phone) {
    await drafts.optOut(row.phone, { reason: note || 'просил не звонить (звонок владельца)', source: 'admin', meta });
  }
}

async function setNote(id, note) {
  await pool.query('UPDATE outreach_prospects SET note = $2, updated_at = NOW() WHERE id = $1', [id, clip(note, LIMITS.note)]);
}

// Компания сказала «да» по телефону: черновик анкеты как у бота (provider_agreed = это «да» владельцу), ссылка /c/<token>.
// Отметка в журнале согласий: кто и когда передал, что компания согласилась на анкету. Согласие на SMS о заявках
// она даёт сама на странице анкеты — эта отметка его не заменяет.
async function createLink(id, { lang = 'ka', confirmedByOwner = false } = {}, meta = {}) {
  if (confirmedByOwner !== true) throw fail('not_confirmed', 'Отметьте, что компания согласилась по телефону.', 400);
  const row = (await pool.query('SELECT * FROM outreach_prospects WHERE id = $1', [id])).rows[0];
  if (!row) throw fail('not_found', 'Not found.', 404);
  if (!row.phone) throw fail('invalid_phone', 'У компании нет грузинского номера: впишите номер в карточку.', 400);
  const p = shape(row);
  const description = stripPhones(p.description) || stripPhones(p.title) || p.name;
  const city = (await drafts.cities())[0];
  const result = await drafts.create({
    phone: p.phone, name: p.name, type: p.services.includes('van') ? ['master', 'vehicle'] : 'master',
    services: p.services, other_services: p.other_services.length || p.services.length ? p.other_services : ['Грузчики'],
    description: description.slice(0, 2000), city: city ? city.id : undefined, lang: ['ka', 'ru', 'en'].includes(lang) ? lang : 'ka',
    source: 'owner_call', external_id: `prospect_${p.id}`, provider_agreed: true,
  });
  await pool.withTransaction(async (client) => {
    await client.query(`UPDATE outreach_prospects SET status = 'agreed', agreed_at = COALESCE(agreed_at, NOW()), draft_public_id = $2, calls = $3::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, result.draft.public_id, pushCall(row, { result: 'agreed', note: result.created ? 'ссылка создана' : 'ссылка повторно' })]);
    await require('./consentLog.service').recordAction({ eventType: 'OUTREACH_PHONE_AGREED', phone: p.phone, channel: 'phone', meta,
      metadata: { actor: 'admin', prospect_id: p.id, draft_id: result.draft.public_id, company: p.name } }, client);
  });
  return { url: drafts.confirmUrl(result.draft.token), expiresAt: result.draft.expires_at, created: result.created };
}

async function remove(id) {
  await pool.query('DELETE FROM outreach_prospects WHERE id = $1', [id]);
}

module.exports = { RESULTS, STATUSES, importMany, list, get, logCall, setNote, createLink, remove, website, phones, stripPhones };
