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

function bundle(rates, language) {
  const lang = Object.hasOwn(copy, language) ? language : 'ka';
  const text = copy[lang];
  const snapshot = { version: 'billing-v1', language: lang, pricing_key: rates.key,
    lead_price_tetri: rates.leadPriceTetri, catalog_call_price_tetri: rates.catalogCallPriceTetri,
    title: text.billing_title, intro: text.billing_intro,
    lead: text.billing_lead.replace('{price}', (rates.leadPriceTetri / 100).toFixed(2)),
    catalog: text.billing_catalog.replace('{price}', (rates.catalogCallPriceTetri / 100).toFixed(2)),
    note: text.billing_note, checkbox: text.billing_check, button: text.billing_button };
  return { ...snapshot, digest: hash(snapshot) };
}

async function accepted(masterId, rates, client = pool) {
  return (await client.query('SELECT consent_log_id FROM master_billing_acceptances WHERE master_id=$1 AND pricing_key=$2', [masterId, rates.key])).rows[0] || null;
}

async function state(masterId, language) {
  const rates = await pricing();
  return { ...bundle(rates, language), accepted: Boolean(await accepted(masterId, rates)) };
}

async function accept(masterToken, body, meta = {}) {
  if (body.accepted !== true) return { status: 400, code: 'billing_required' };
  return pool.withTransaction(async client => {
    const master = (await client.query('SELECT * FROM masters WHERE master_token=$1 FOR UPDATE', [masterToken])).rows[0];
    if (!master || master.is_banned) return { status: 403, code: 'billing_error' };
    const rates = await pricing(client, true);
    const snapshot = bundle(rates, body.language);
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

async function eligibleIds(rates, client = pool) {
  return new Set((await client.query('SELECT master_id FROM master_billing_acceptances WHERE pricing_key=$1', [rates.key])).rows.map(row => row.master_id));
}

module.exports = { pricing, bundle, state, accept, accepted, eligibleIds };
