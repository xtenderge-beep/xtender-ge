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
      options: (f.options || []).map(value => ({value, label: f.optionLabels?.[value]?.[lang] || f.optionLabels?.[value]?.ru || value})) })) };
}
// Есть ли у категории хоть одно 'size'-поле (сейчас только van) — единственное, что
// реально не отдаётся в форму: значение проставляется легаси-колонкой vehicle_size
// (см. admin/master-detail.ejs), а не этим движком, так что открывать его редактирование
// сейчас означало бы менять конфиг, который ни на что не влияет. Остальные встроенные
// категории (movers/tow/bucket_lift/junk) — обычные text/number/bool/enum поля,
// редактируются через тот же parseFields, что и пользовательские категории.
function hasLockedField(fields) { return (fields || []).some(f => f.input === 'size'); }
async function configForView(lang = 'ru') { return (await list()).filter(r=>r.is_active).map(r=>view(r,lang)); }
async function groups(includeDisabled = false) {
  const result = {};
  for (const row of await list()) if (includeDisabled || row.is_active) {
    result[toCategory(row.slug)] = (row.icon ? row.icon+' ' : '') + row.name_ru;
    if (row.slug === 'van') result.flatbed = '🚛 Бортовые';
  }
  return result;
}
// Подписи групп по ключам, которыми оперирует заявка (target_categories / masters.category):
// 'transport', а не slug справочника 'van' (см. toCategory), плюс 'flatbed' — это не строка
// справочника, а вариант van (как в groups()), его подпись берём из перевода типа кузова.
// Нужна там, где клиенту показывают категории его заявки; без этого подпись не находилась
// и клиент видел сырой ключ «transport».
async function labelMap(lang = 'ru') {
  const map = Object.fromEntries((await configForView(lang)).map(row => [toCategory(row.type), row.label]));
  if (map.transport) map.flatbed = translate(lang)('svc_van_body_flatbed');
  return map;
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
// Вариант списка хранит стабильное машинное значение отдельно от подписи (как и само
// поле) — иначе редактирование подписи или смена языка переприсваивало бы value, а
// уже сохранённые в master_services.attributes значения переставали бы совпадать ни
// с одним вариантом. Если админ не трогал вариант — форма шлёт то же value, что и
// раньше (в т.ч. старые плоские строки от полей, созданных до этого изменения — они
// тоже считаются «существующими» и не перегенерируются).
function parseOptions(input, previousOptions) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 20) throw fail('Укажите от 2 до 20 вариантов списка.');
  const seenValues = new Set();
  const options = []; const optionLabels = {};
  input.forEach(o => {
    const value = (typeof o.value === 'string' && previousOptions.includes(o.value)) ? o.value : 'o_'+randomBytes(4).toString('hex');
    if (seenValues.has(value)) throw fail('Некорректный вариант списка.');
    seenValues.add(value);
    const nameRu = text(o.name_ru, 100, 'Вариант списка');
    const labels = { ru: nameRu };
    ['ka','en'].forEach(lang => {
      const raw = typeof o['name_'+lang] === 'string' ? o['name_'+lang].trim() : '';
      if (raw) { if (raw.length > 100) throw fail('Вариант списка: до 100 символов.'); labels[lang] = raw; }
    });
    options.push(value); optionLabels[value] = labels;
  });
  return { options, optionLabels };
}
function parseFields(input, previous) {
  if (!Array.isArray(input) || input.length > 12) throw fail('Можно добавить до 12 характеристик.');
  const seen = new Set();
  return input.map(f=> {
    // Built-in fields keep their meaningful static keys (crew_size, tow_type, …), which
    // never matched the f_xxxxxxxx pattern generated for admin-created ones — so the
    // format check only applies when we're minting a brand-new key; an existing key just
    // has to actually belong to this category (previous), whatever shape it has.
    const key = f.key || 'f_'+randomBytes(4).toString('hex');
    if (seen.has(key)) throw fail('Некорректная характеристика.');
    if (f.key) { if (!previous.some(p=>p.key===key)) throw fail('Некорректная характеристика.'); }
    else if (!/^f_[a-f0-9]{8}$/.test(key)) throw fail('Некорректная характеристика.');
    seen.add(key);
    if(!['text','number','bool','enum'].includes(f.input)) throw fail('Неизвестный тип характеристики.');
    const prevField = previous.find(p => p.key === key) || null;
    const nameRu=text(f.name_ru,100,'Название характеристики');
    const labels={ru:nameRu};
    ['ka','en'].forEach(lang=>{
      const raw=typeof f['name_'+lang]==='string' ? f['name_'+lang].trim() : '';
      if(raw){ if(raw.length>100) throw fail('Название характеристики: до 100 символов.'); labels[lang]=raw; }
    });
    const allowedMatches = {text:['ignore'],number:['ignore','exact','gte'],bool:['ignore','flag'],enum:['ignore','exact','gte']};
    const match = f.match || prevField?.match || 'ignore';
    if (!allowedMatches[f.input].includes(match)) throw fail('Некорректное правило подбора для характеристики.');
    const out={key,input:f.input,labels,required:f.required===true,match};
    if (f.filter === true && match === 'ignore') throw fail('Для фильтра каталога задайте правило подбора.');
    if (f.filter === true || (f.filter === undefined && prevField?.filter)) out.filter = true;
    if (prevField?.optionIcons) out.optionIcons = prevField.optionIcons;
    if (out.input==='number') {
      const unit = typeof f.unit==='string' ? f.unit.trim() : '';
      if (unit) { if (unit.length>16) throw fail('Единица измерения: до 16 символов.'); out.unit=unit; }
      const min = f.min==='' || f.min==null ? null : Number(f.min);
      const max = f.max==='' || f.max==null ? null : Number(f.max);
      if (min!==null) { if(!Number.isFinite(min)) throw fail('Минимум: некорректное число.'); out.min=min; }
      if (max!==null) { if(!Number.isFinite(max)) throw fail('Максимум: некорректное число.'); out.max=max; }
      if (out.min!=null && out.max!=null && out.min>out.max) throw fail('Минимум не может быть больше максимума.');
    } else if (prevField?.unit) {
      // Число с единицей может прийти и в enum-поле (напр. тоннаж эвакуатора — список
      // вариантов, но подпись "8 т"). Форма пока не даёт редактировать unit не у number —
      // просто переносим как было, чтобы не терять его при обычном сохранении.
      out.unit = prevField.unit;
    }
    if(out.input==='enum') {
      const parsed = parseOptions(Array.isArray(f.options) ? f.options : [], prevField?.options || []);
      out.options = parsed.options; out.optionLabels = parsed.optionLabels;
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
    // Поле 'size' (если есть) сохраняем как было — его не отдаём в форму (см.
    // category-edit.ejs) и не пускаем через parseFields (не входит в допустимые типы),
    // но остальные характеристики этой же категории редактируются обычным образом.
    const lockedFields=(previous?.fields || []).filter(f=>f.input==='size');
    const editableExisting=(previous?.fields || []).filter(f=>f.input!=='size');
    const fields=[...lockedFields, ...parseFields(input.fields || [],editableExisting)];
    if (previous) {
      const assignments=(await client.query('SELECT attributes FROM master_services WHERE service_type=$1',[previous.slug])).rows;
      for (const oldField of editableExisting) {
        if (!assignments.some(row => row.attributes?.[oldField.key] !== undefined && row.attributes?.[oldField.key] !== null && row.attributes?.[oldField.key] !== '')) continue;
        const nextField=fields.find(field=>field.key===oldField.key);
        if (!nextField || nextField.input!==oldField.input) throw fail('Характеристика уже используется исполнителями. Оставьте её в справочнике и добавьте новую.',409);
        if (oldField.input==='enum' && oldField.options.some((option,index)=>nextField.options[index]!==option)) throw fail('Используемые варианты нельзя удалять или менять местами. Можно добавить новые варианты в конец списка.',409);
      }
    }
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
// Полное удаление — только если категорией никто не пользуется: иначе профили
// специалистов останутся с category/service_type, которого больше нет в
// service_categories (validate/get на него больше не найдут строку), а это ломает
// повторное одобрение, каталог и рассылку по этому типу. В остальных случаях
// предлагаем «Категория активна» = false — она уже скрывается из новых назначений,
// каталога и рассылки, но профили и история не трогаются (см. подсказку в форме).
async function remove(slug) {
  return pool.withTransaction(async client => {
    const row = await get(slug, client);
    if (!row) throw fail('Категория не найдена.', 404);
    const mastersCount = Number((await client.query('SELECT COUNT(*)::int AS n FROM masters WHERE category=$1', [toCategory(slug)])).rows[0].n);
    const servicesCount = Number((await client.query('SELECT COUNT(*)::int AS n FROM master_services WHERE service_type=$1', [toType(slug)])).rows[0].n);
    if (mastersCount > 0 || servicesCount > 0) {
      throw fail(`Нельзя удалить: категорию используют специалисты (${Math.max(mastersCount, servicesCount)}). Сначала переназначьте им категорию в их профиле или снимите отметку «Категория активна» — она скроется из новых назначений, а профили и история сохранятся.`, 409);
    }
    await client.query('DELETE FROM service_categories WHERE slug=$1', [slug]);
  });
}
module.exports={list,get,validate,view,configForView,groups,labelMap,catalogGroups,badges,save,remove,toType,toCategory,hasLockedField};
