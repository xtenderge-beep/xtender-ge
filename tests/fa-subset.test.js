// Публичные страницы грузят не полный Font Awesome, а мини-подмножество (public/fa/, собирается
// scripts/build-fa.js). Иконка, добавленная в шаблон, но не внесённая в список ICONS, молча
// не рисуется (так пропали ✕ на кнопках закрытия по категориям и стрелка на /join).
// Тест ловит это заранее: каждая иконка публичных шаблонов должна быть в собранном fa.css.
// Админка (views/admin) грузит только app.css без fa.css — её иконки не проверяем.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const built = fs.readFileSync(path.join(root, 'public/fa/fa.css'), 'utf8');
const inSubset = (name) => built.includes('.fa-' + name + ':before');

const used = new Map();
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(path.join(root, 'src/views'), full) === 'admin') continue;
      walk(full);
    } else if (entry.name.endsWith('.ejs')) {
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/fa-(?:solid|regular|brands)\s+fa-([a-z0-9-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
})(path.join(root, 'src/views'));

const missing = [...used].filter(([name]) => !inSubset(name))
  .map(([name, files]) => `fa-${name} (${[...files].join(', ')})`);
assert.deepEqual(missing, [], 'icons used in public templates but absent from public/fa/fa.css — add them to ICONS in scripts/build-fa.js and run npm run build:fa');

console.log(`fa-subset.test.js: all ${used.size} icons used by public templates are in the subset`);
