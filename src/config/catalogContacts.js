// Only normalized contact identifiers are stored. URLs are constructed by us.
function parse(body) {
  const result = {};
  for (const key of ['whatsapp', 'viber']) {
    const raw = body[key];
    if (typeof raw !== 'string') return null;
    const value = raw.trim().replace(/[\s()-]/g, '');
    if (value && !/^\+[1-9]\d{7,14}$/.test(value)) return null;
    result[key] = value;
  }
  if (typeof body.telegram !== 'string') return null;
  result.telegram = body.telegram.trim().replace(/^https:\/\/t\.me\//i, '').replace(/^@/, '');
  if (result.telegram && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(result.telegram)) return null;
  return result;
}
function links(master) {
  const c = master.contact_channels || {};
  const result = { call: 'tel:' + master.phone };
  if (/^\+[1-9]\d{7,14}$/.test(c.whatsapp || '')) result.whatsapp = 'https://wa.me/' + c.whatsapp.slice(1);
  if (/^\+[1-9]\d{7,14}$/.test(c.viber || '')) result.viber = 'viber://chat?number=' + encodeURIComponent(c.viber);
  if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c.telegram || '')) result.telegram = 'https://t.me/' + c.telegram;
  return result;
}
module.exports = { parse, links };
