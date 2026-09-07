/*
 * Собирает МИНИ-подмножество Font Awesome 6 из тех иконок, что реально используются
 * в публичных шаблонах, и кладёт в public/fa/ (свой хостинг вместо cdnjs).
 *
 *   node scripts/build-fa.js
 *
 * Выход: public/fa/fa.css + fa-solid.woff2 / fa-regular.woff2 / fa-brands.woff2
 * (только нужные глифы — ~10 КБ вместо ~350 КБ трёх полных шрифтов + CDN-CSS).
 *
 * Если добавили новую иконку в шаблон — впишите её в ICONS ниже и перезапустите.
 * @fortawesome/fontawesome-free и subset-font — в devDependencies, нужны только тут.
 */
const fs = require('fs');
const path = require('path');
const subsetFont = require('subset-font');

const FA = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
const OUT = path.join(__dirname, '..', 'public', 'fa');

// style → список имён иконок (из grep "fa-(solid|regular|brands) fa-*" по src/views + serviceTypes.js)
const ICONS = {
  solid: [
    'address-book', 'arrow-left', 'arrow-right', 'bolt', 'briefcase', 'building-columns',
    'check', 'chevron-down', 'circle-check', 'circle-info', 'clock', 'eye', 'gift',
    'headset', 'helmet-safety', 'key', 'list-check', 'lock', 'mobile-screen',
    'paper-plane', 'paperclip', 'pen', 'phone', 'right-to-bracket', 'shield-halved',
    'square-plus', 'star', 'tag', 'trash-can', 'triangle-exclamation',
    'truck', 'truck-pickup',
  ],
  regular: ['copy', 'image'],
  brands: ['telegram', 'whatsapp'],
};

const FONT_FILE = {
  solid: 'fa-solid-900.woff2',
  regular: 'fa-regular-400.woff2',
  brands: 'fa-brands-400.woff2',
};

// Юникод иконки: сперва из metadata/icons.json, иначе парсим из css/all.min.css.
let META = null;
try { META = require('@fortawesome/fontawesome-free/metadata/icons.json'); } catch { /* нет в этой версии */ }
const ALL_CSS = fs.readFileSync(path.join(FA, 'css', 'all.min.css'), 'utf8');

function unicodeFor(name) {
  if (META && META[name] && META[name].unicode) return META[name].unicode;
  const m = ALL_CSS.match(new RegExp('\\.fa-' + name + ':before[^{]*\\{content:"\\\\([0-9a-f]+)"'));
  if (!m) throw new Error('не нашёл юникод для fa-' + name);
  return m[1];
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });

  // Минимальный движок FA6 (без 80 КБ регистраций всех имён из fontawesome.min.css):
  // достаточно, чтобы <i class="fa-solid fa-phone"> отрисовал глиф из ::before.
  const core = [
    '.fa,.fa-brands,.fa-regular,.fa-solid,.fab,.far,.fas{',
    '-moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;',
    'display:var(--fa-display,inline-block);font-style:normal;font-variant:normal;',
    'line-height:1;text-rendering:auto}',
    '.fa,.fa-regular,.fa-solid,.far,.fas{font-family:"Font Awesome 6 Free"}',
    '.fa,.fa-solid,.fas{font-weight:900}',
    '.fa-regular,.far{font-weight:400}',
    '.fa-brands,.fab{font-family:"Font Awesome 6 Brands";font-weight:400}',
    ':is(.fa,.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands)::before{',
    '-webkit-font-smoothing:antialiased;display:inline-block;text-rendering:auto}',
  ].join('');

  let css = '/* Font Awesome 6.5.1 — subset for xtender.ge, built by scripts/build-fa.js */\n' + core + '\n';
  const iconRules = [];

  for (const [style, names] of Object.entries(ICONS)) {
    const family = style === 'brands' ? 'Font Awesome 6 Brands' : 'Font Awesome 6 Free';
    const weight = style === 'solid' ? 900 : 400;

    const codepoints = names.map(unicodeFor);
    const text = codepoints.map((hex) => String.fromCodePoint(parseInt(hex, 16))).join('');

    const src = fs.readFileSync(path.join(FA, 'webfonts', FONT_FILE[style]));
    const subset = await subsetFont(src, text, { targetFormat: 'woff2' });
    const outName = `fa-${style}.woff2`;
    fs.writeFileSync(path.join(OUT, outName), subset);
    console.log(`${outName}: ${(src.length / 1024).toFixed(0)}KB → ${(subset.length / 1024).toFixed(1)}KB (${names.length} icons)`);

    css += `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(/fa/${outName}) format("woff2")}\n`;
    names.forEach((name, i) => iconRules.push(`.fa-${name}:before{content:"\\${codepoints[i]}"}`));
  }

  css += iconRules.join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, 'fa.css'), css);
  console.log(`fa.css: ${(css.length / 1024).toFixed(1)}KB (${iconRules.length} icon rules)`);
}

run().catch((err) => { console.error(err); process.exit(1); });
