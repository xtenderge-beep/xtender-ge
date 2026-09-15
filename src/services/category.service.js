const pool = require('../config/db');
const base = require('../config/serviceTypes');
const { translate } = require('../config/i18n');
const { randomBytes } = require('crypto');
const toType = key => key === 'transport' || key === 'flatbed' ? 'van' : key;
const toCategory = key => key === 'van' ? 'transport' : key;
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function list(client = pool) { return (await client.query('SELECT * FROM service_categories ORDER BY sort_order, name_ru, slug')).rows; }
async function get(key, client = pool) { return (await client.query('SELECT * FROM service_categories WHERE slug=$1', [toType(key)])).rows[0] || null; }
function validate(row, raw) {
  if (!row || !row.is_active) return { attributes: {}, errors: ['category'] };
  return base.validateAttributes(row.slug, raw || {}, row.fields);
}
function view(row, lang = 'ru') {
  const t = translate(lang);
  return { type: row.slug, label: row['name_'+lang] || row.name_ru, icon: row.icon, active: row.is_active,
    fields: row.fields.map(f => ({ ...f, min: f.min ?? null, max: f.max ?? null,
      label: f.labels?.[lang] || f.labels?.ru || t('svc_'+row.slug+'_'+f.key),
      options: (f.options || []).map(value => ({value, label: f.optionLabels?.[value]?.[lang] || value})) })) };
}
async function configForView(lang = 'ru') { return (await list()).filter(r=>r.is_active).map(r=>view(r,lang)); }
async function groups(includeDisabled = false) {
  const result = {};
  for (const row of await list()) if (includeDisabled || row.is_active) {
    result[toCategory(row.slug)] = (row.icon ? row.icon+' ' : '') + row.name_ru;
    if (row.slug === 'van') result.flatbed = '🚛 Бортовые';
  }
  return result;
}
async function catalogGroups(lang) {
  return (await list()).filter(r=>r.is_active).map(r=>({key:r.slug,label:r['name_'+lang] || r.name_ru,icon:r.icon,
    color:base.SERVICE_TYPES[r.slug]?.catalogColor || 'bg-stone-100 text-stone-900 border-stone-300',anchor:'group-'+r.slug}));
}
function badges(row, attributes, lang) {
  if (!row) return [];
  const a=attributes || {};
  return view(row,lang).fields.flatMap(f=> {
    const v=a[f.key];if(v === undefined || v === null || v === '' || v === false) return [];
    if(f.input==='bool') return [f.label];
    if(f.input==='enum') return [f.options.find(o=>o.value===v)?.label || String(v)];
    if(f.input==='text') return [f.label+': '+v];
    return [String(v)+(f.unit ? ' '+f.unit : '')];
  });
}
function text(value, max, label) {
  if(typeof value !== 'string' || !value.trim() || value.trim().length>max) throw fail(label+': заполните поле (до '+max+' символов).');
  return value.trim();
}
function parseFields(input, previous) {
  if (!Array.isArray(input) || input.length > 12) throw fail('Можно добавить до 12 характеристик.');
  const seen = new Set();
  return input.map(f=> {
    const key = f.key || 'f_'+randomBytes(4).toString('hex');
    if(!/^f_[a-f0-9]{8}$/.test(key) || seen.has(key) || (f.key && !previous.some(p=>p.key===key))) throw fail('Некорректная характеристика.');
    seen.add(key);
    if(!['text','number','bool','enum'].includes(f.input)) throw fail('Неизвестный тип характеристики.');
    const nameRu=text(f.name_ru,100,'Название характеристики');
    const labels={ru:nameRu};
    ['ka','en'].forEach(lang=>{
      const raw=typeof f['name_'+lang]==='string' ? f['name_'+lang].trim() : '';
      if(raw){ if(raw.length>100) throw fail('Название характеристики: до 100 символов.'); labels[lang]=raw; }
    });
    const out={key,input:f.input,labels,required:f.required===true,match:'ignore'};
    if(out.input==='enum') {
      out.options=text(f.choices,1000,'Варианты').split('\n').map(s=>s.trim()).filter(Boolean);
      if(out.options.length<2 || out.options.length>20 || out.options.some(s=>s.length>100) || new Set(out.options).size!==out.options.length) throw fail('Укажите от 2 до 20 разных вариантов, каждый с новой строки.');
    }
    return out;
  });
}
async function save(slug, input) {
  return pool.withTransaction(async client=> {
    const previous=slug ? await get(slug,client) : null;
    if(slug && !previous) throw fail('Категория не найдена.',404);
    const names=['ka','ru','en'].map(lang=>text(input['name_'+lang],80,'Название категории'));
    const icon=typeof input.icon==='string' ? input.icon.trim() : '';
    if(icon.length>16) throw fail('Значок слишком длинный.');
    const order=Number(input.sort_order || 100);
    if(!Number.isSafeInteger(order) || order<0 || order>10000) throw fail('Порядок: число от 0 до 10000.');
    const fields=previous?.is_builtin ? previous.fields : parseFields(input.fields || [],previous?.fields || []);
    const active=input.is_active===true;
    if(previous) {
      const result=await client.query('UPDATE service_categories SET name_ka=$1,name_ru=$2,name_en=$3,icon=$4,fields=$5::jsonb,is_active=$6,sort_order=$7,version=version+1 WHERE slug=$8 AND version=$9 RETURNING *', [...names,icon,JSON.stringify(fields),active,order,slug,Number(input.version)]);
      if(!result.rows[0]) throw fail('Категория уже изменена. Обновите страницу перед сохранением.',409);
      return result.rows[0];
    }
    const key='svc_'+randomBytes(6).toString('hex');
    return (await client.query('INSERT INTO service_categories(slug,name_ka,name_ru,name_en,icon,fields,is_active,sort_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',[key,...names,icon,JSON.stringify(fields),active,order])).rows[0];
  });
}
module.exports={list,get,validate,view,configForView,groups,catalogGroups,badges,save,toType,toCategory};
