// Панели фильтров каталога по характеристикам услуг (кузов, тоннаж, высота...) видны только
// для выбранной категории. Регрессия 2026-09-30: панели скрывались атрибутом hidden при классе
// flex — CSS-класс перебивает атрибут, и при «Грузчиках» показывались фильтры всех услуг.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../src/views/index.ejs'),'utf8');
const panels=[...source.matchAll(/<div data-catalog-field-panel=.*$/gm)].map(m=>m[0]);
assert.equal(panels.length,1,'one panel template');
assert.match(panels[0],/class="hidden flex-wrap /,'panel starts hidden via class');
assert.doesNotMatch(panels[0],/\shidden\s+class=/,'no hidden attribute next to a display class');
assert.doesNotMatch(panels[0],/class="flex /,'no display:flex before the category is chosen');
assert.match(source,/panel\.classList\.toggle\('hidden', !on\); panel\.classList\.toggle\('flex', on\);/,'visibility toggled by class');
assert.doesNotMatch(source,/panel\.hidden\s*=/,'hidden property alone does not hide a flex element');
assert.match(source,/<option value=""><%= t\('filter_all'\) %><\/option>/,'"All" option is translated');
console.log('PASS: catalog attribute filter panels are shown only for the selected category');
