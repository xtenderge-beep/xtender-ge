const crypto = require('node:crypto');
const pool = require('../config/db');
const settings = require('./settings.service');
const copy = require('../config/provider-consent-copy');
const audit = require('./consentLog.service');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const content = Object.fromEntries(Object.entries(copy).map(([lang, text]) => [lang,
  Object.fromEntries(Object.entries(text).filter(([key]) => key.startsWith('billing_')))]));

async function pricing(client = pool, lock = false) {
  const rows = (await client.query("SELECT key,value FROM app_settings WHERE key IN ('lead_price_tetri','catalog_call_price_tetri','billing_rates_revision') ORDER BY key" + (lock ? ' FOR SHARE' : ''))).rows;
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  const price = (key, fallback) => { const n = parseInt(values[key], 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
  const rates = { leadPriceTetri: price('lead_price_tetri', settings.DEFAULT_LEAD_PRICE_TETRI),
    catalogCallPriceTetri: price('catalog_call_price_tetri', settings.DEFAULT_CATALOG_CALL_PRICE_TETRI),
    revision: values.billing_rates_revision || 'initial' };
  return { ...rates, key: hash({ rates, content }) };
}

// gift — у исполнителя на балансе только подарок: вступление говорит правду о том, что тарифы уже
// действуют для бонусного баланса. Показанный текст попадает в снимок и в digest.
function bundle(rates, language, { gift = false } = {}) {
  const lang = Object.hasOwn(copy, language) ? language : 'ka';
  const text = copy[lang];
  const snapshot = { version: 'billing-v1', language: lang, pricing_key: rates.key,
    lead_price_tetri: rates.leadPriceTetri, catalog_call_price_tetri: rates.catalogCallPriceTetri,
    title: text.billing_title, intro: gift ? text.rates_gift_intro : text.billing_intro,
    lead: text.billing_lead.replace('{price}', (rates.leadPriceTetri / 100).toFixed(2)),
    catalog: text.billing_catalog.replace('{price}', (rates.catalogCallPriceTetri / 100).toFixed(2)),
    note: text.billing_note, checkbox: text.billing_check, button: text.billing_button };
  return { ...snapshot, digest: hash(snapshot) };
}

async function accepted(masterId, rates, client = pool) {
  return (await client.query('SELECT consent_log_id FROM master_billing_acceptances WHERE master_id=$1 AND pricing_key=$2', [masterId, rates.key])).rows[0] || null;
}

// Подарочный баланс (приветственный бонус и промокод, reason 'promo') расходуется без подтверждения
// тарифов: своих денег исполнитель не теряет. Любое другое зачисление (перевод, ручная коррекция
// вверх) считается его деньгами, и с этого момента списания требуют подтверждённых тарифов.
async function ownFunds(masterId, client = pool) {
  return (await client.query("SELECT id FROM balance_transactions WHERE master_id=$1 AND amount_tetri > 0 AND reason <> 'promo' LIMIT 1", [masterId])).rows.length > 0;
}

// Основание для списания: подтверждённые тарифы либо баланс без денег исполнителя. null — списывать нельзя.
async function permission(masterId, rates, client = pool) {
  const acceptance = await accepted(masterId, rates, client);
  if (acceptance) return { basis: 'accepted_rates', consent_log_id: acceptance.consent_log_id };
  return await ownFunds(masterId, client) ? null : { basis: 'gift_balance', consent_log_id: null };
}

// required — на балансе есть свои деньги, а действующие тарифы не подтверждены: платные функции на паузе.
async function state(masterId, language) {
  const rates = await pricing();
  const isAccepted = Boolean(await accepted(masterId, rates));
  const funded = await ownFunds(masterId);
  return { ...bundle(rates, language, { gift: !funded }), accepted: isAccepted, required: funded && !isAccepted };
}

async function accept(masterToken, body, meta = {}) {
  if (body.accepted !== true) return { status: 400, code: 'billing_required' };
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT * FROM masters WHERE master_token=$1 FOR UPDATE', [masterToken])).rows[0];
    if (!master || master.is_banned) return { status: 403, code: 'billing_error' };
    const rates = await pricing(client, true);
    const snapshot = bundle(rates, body.language, { gift: !await ownFunds(master.id, client) });
    if (snapshot.digest !== body.digest) return { status: 409, code: 'billing_stale' };
    const existing = await accepted(master.id, rates, client);
    if (existing) return { status: 200, consentLogId: existing.consent_log_id };
    const log = await audit.recordAction({ eventType: 'PROVIDER_BILLING_ACCEPTED', phone: master.phone,
      masterId: master.id, meta, metadata: { snapshot, accepted: true, method: 'authenticated_checkbox',
        master_terms_accepted_at: master.terms_accepted_at } }, client);
    await client.query(`INSERT INTO master_billing_acceptances(master_id,pricing_key,consent_log_id)
      VALUES($1,$2,$3) ON CONFLICT(master_id) DO UPDATE SET pricing_key=EXCLUDED.pricing_key,
      consent_log_id=EXCLUDED.consent_log_id,accepted_at=NOW()`, [master.id, rates.key, log.id]);
    return { status: 200, consentLogId: log.id };
  });
}

// Кому платные функции разрешены: подтвердившие действующие тарифы и те, у кого на балансе только подарок.
async function eligibleIds(rates, client = pool) {
  const ids = new Set((await client.query('SELECT master_id FROM master_billing_acceptances WHERE pricing_key=$1', [rates.key])).rows.map(row => row.master_id));
  const funded = new Set((await client.query("SELECT DISTINCT master_id FROM balance_transactions WHERE amount_tetri > 0 AND reason <> 'promo'")).rows.map(row => row.master_id));
  for (const row of (await client.query('SELECT id FROM masters')).rows) if (!funded.has(row.id)) ids.add(row.id);
  return ids;
}

module.exports = { pricing, bundle, state, accept, accepted, permission, ownFunds, eligibleIds };
