// Plain-text <-> block-array format for legal documents (Оферта/Политика), so an admin
// can edit them as a textarea instead of hand-editing JS. Blocks are the same shape
// partials/legal-blocks.ejs already renders: { h }, { p }, { ul: [...] }, { requisites: true }.
//
// Convention (one blank line between blocks):
//   ## Заголовок        -> { h: 'Заголовок' }
//   - пункт             -> consecutive "- " lines group into one { ul: [...] }
//   [[REQUISITES]]      -> { requisites: true }
//   anything else       -> { p: 'текст' }
//
// renderDocBody is the exact inverse: parseDocBody(renderDocBody(blocks)) is equivalent
// to blocks (see tests/legal-editor.test.js), so the admin always sees the same document
// they'd get from the fallback in legal-content.js, editable and re-saveable losslessly.

function parseDocBody(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let ul = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { ul = null; continue; }
    if (line === '[[REQUISITES]]') { blocks.push({ requisites: true }); ul = null; continue; }
    if (line.startsWith('## ')) { blocks.push({ h: line.slice(3).trim() }); ul = null; continue; }
    if (line.startsWith('- ')) {
      const item = line.slice(2).trim();
      if (!ul) { ul = []; blocks.push({ ul }); }
      ul.push(item);
      continue;
    }
    blocks.push({ p: line });
    ul = null;
  }
  return blocks;
}

function renderDocBody(blocks) {
  return (blocks || []).map((b) => {
    if (b.h) return '## ' + b.h;
    if (b.p) return b.p;
    if (b.ul) return b.ul.map((li) => '- ' + li).join('\n');
    if (b.requisites) return '[[REQUISITES]]';
    return '';
  }).join('\n\n');
}

module.exports = { parseDocBody, renderDocBody };
