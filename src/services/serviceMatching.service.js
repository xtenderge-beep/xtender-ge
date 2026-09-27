const pool = require('../config/db');
const toType = category => ['transport', 'flatbed'].includes(category) ? 'van' : category;
const toCategory = type => type === 'van' ? 'transport' : type;

// Legacy profiles remain readable until they are edited in the multi-service form.
async function servicesFor(master, client = pool, suppliedRows = null) {
  const rows = suppliedRows || (await client.query('SELECT service_type, attributes, is_primary, requires_own_transport FROM master_services WHERE master_id=$1', [master.id])).rows;
  if (rows.length) return rows;
  return master.category ? [{ service_type: toType(master.category), attributes: { size: master.vehicle_size, body: master.is_flatbed ? 'flatbed' : 'closed' }, requires_own_transport: false }] : [];
}

function matches(services, category, size = '', openCategories = [], requirements = {}) {
  const service = services.find(s => s.service_type === toType(category));
  if (!service) return false;
  const a = service.attributes || {};
  if (category === 'flatbed' && a.body !== 'flatbed') return false;
  if (size && a.size !== size) return false;
  if (!require('./serviceRequirements.service').matches(a, requirements?.services?.[category], requirements?.rules?.[category])) return false;
  if (service.requires_own_transport) {
    return openCategories.some(c => ['transport', 'flatbed'].includes(c) && matches(services, c, requirements?.transport_size || '', openCategories, requirements));
  }
  return true;
}

async function openMatches(master, order, client = pool) {
  if (!['new', 'pending_review'].includes(order.status)) return [];
  if (!(await coversCity(master, order, client))) return [];
  const closed = (await client.query('SELECT category FROM order_category_closures WHERE order_id=$1', [order.id])).rows.map(r => r.category);
  const open = (Array.isArray(order.target_categories) ? order.target_categories : []).filter(c => !closed.includes(c));
  const definitions = await require('./category.service').list(client);
  const active = new Set(definitions.filter(d => d.is_active).map(d => d.slug));
  const services = (await servicesFor(master, client)).filter(s => active.has(s.service_type));
  return open.filter(c => matches(services, c, c === 'transport' ? order.requirements?.transport_size || '' : '', open, order.requirements));
}

// An order without a city is a legacy Tbilisi order, never an all-country order.
// Profiles without coverage are likewise legacy Tbilisi profiles.
async function coversCity(master, order, client = pool) {
  const city = order.city_id
    ? (await client.query('SELECT id,slug FROM cities WHERE id=$1', [order.city_id])).rows[0]
    : (await client.query("SELECT id,slug FROM cities WHERE slug='tbilisi'")).rows[0];
  if (!city) return false;
  const coverage = (await client.query('SELECT city_id FROM master_cities WHERE master_id=$1', [master.id])).rows;
  if (coverage.length) return coverage.some(row => row.city_id === city.id);
  return master.city_id ? master.city_id === city.id : city.slug === 'tbilisi';
}

module.exports = { servicesFor, matches, openMatches, coversCity, toType, toCategory };
