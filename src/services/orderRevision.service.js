const crypto = require('crypto');
const pool = require('../config/db');
const consentLog = require('./consentLog.service');

const csrfFor = order => crypto.createHash('sha256').update('order-revision:' + order.owner_token + ':' + (order.revision_version || 0)).digest('hex');

async function requestRevision(token, reason, meta = {}) {
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 1000) throw new Error('Укажите причину от 5 до 1000 символов.');
  return pool.withTransaction(async client => {
    const { rows } = await client.query(`UPDATE orders SET status = 'needs_revision', revision_reason = $2,
      revision_requested_at = NOW(), revision_version = revision_version + 1
      WHERE token = $1 AND status = 'pending_review' AND first_dispatched_at IS NULL RETURNING *`, [token, reason.trim()]);
    const order = rows[0];
    if (!order) return null;
    await consentLog.recordAction({ eventType: 'ORDER_REVISION_REQUESTED', orderId: order.id, phone: order.phone,
      metadata: { reason: reason.trim(), revision: order.revision_version, actor: 'admin' }, meta }, client);
    return order;
  });
}

async function resubmit(token, ownerToken, version, description, district, lang, meta = {}) {
  if (typeof description !== 'string' || description.trim().length < 10 || description.trim().length > 5000 || typeof district !== 'string' || district.trim().length > 200) throw new Error('INVALID_DETAILS');
  return pool.withTransaction(async client => {
    const { rows } = await client.query(`UPDATE orders SET description = $4, district_name = $5,
      description_translations = '{}'::jsonb, source_lang = $6, status = 'pending_review', revision_version = revision_version + 1
      WHERE token = $1 AND owner_token = $2 AND revision_version = $3 AND status = 'needs_revision'
        AND first_dispatched_at IS NULL RETURNING *`, [token, ownerToken, version, description.trim(), district.trim(), lang]);
    const order = rows[0];
    if (!order) return null;
    await consentLog.recordAction({ eventType: 'ORDER_RESUBMITTED', orderId: order.id, phone: order.phone,
      metadata: { description: order.description, district_name: order.district_name, revision: order.revision_version, actor: 'client' }, meta }, client);
    return order;
  });
}

module.exports = { csrfFor, requestRevision, resubmit };
