const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const db = newDb();
db.public.none(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
const { Pool } = db.adapters.createPg();
const pool = new Pool();
require.cache[require.resolve('../src/config/db')] = { exports: pool };

const { parseDocBody, renderDocBody } = require('../src/config/legalTextFormat');
const legacyContent = require('../src/config/legal-content');
const legalContentService = require('../src/services/legalContent.service');
const consentService = require('../src/services/consent.service');

(async () => {
  // Round-trip: today's real Оферта/Политика text (all 3 languages) survives
  // render -> parse unchanged — the format the admin edits is lossless for real content,
  // not just toy examples.
  for (const doc of [legacyContent.terms, legacyContent.privacy]) {
    for (const lang of ['ka', 'ru', 'en']) {
      const roundTripped = parseDocBody(renderDocBody(doc.body[lang]));
      assert.deepEqual(roundTripped, doc.body[lang], `round-trip mismatch for ${lang}`);
    }
  }

  // No app_settings row yet -> service falls back to legal-content.js unchanged.
  const initialTerms = await legalContentService.getTerms();
  assert.equal(initialTerms.version, legacyContent.terms.version);
  assert.deepEqual(initialTerms.body.ka, legacyContent.terms.body.ka);

  // An empty language is rejected — can't silently ship a document missing a language.
  await assert.rejects(
    () => legalContentService.saveTerms({ ka: 'Test', ru: '', en: 'Test' }),
    /не может быть пустым/
  );
  // The rejected attempt above wrote nothing.
  assert.equal((await legalContentService.getTerms()).version, legacyContent.terms.version);

  // A valid save persists, auto-bumps MINOR (MAJOR unchanged) with today's date, and the
  // block structure matches the ## / - / paragraph convention exactly.
  const before = await legalContentService.getTerms();
  const edited = await legalContentService.saveTerms({
    ka: '## Raздели\n\nსატესტო აბზაცი.',
    ru: '## Раздел\n\n- Пункт один\n- Пункт два\n\nОбновлённый тестовый текст на русском.',
    en: '## Section\n\nUpdated test paragraph in English.',
  });
  const [, beforeMajor, beforeMinor] = /^v(\d+)\.(\d+)-/.exec(before.version);
  const [, afterMajor, afterMinor] = /^v(\d+)\.(\d+)-/.exec(edited.version);
  assert.equal(afterMajor, beforeMajor);
  assert.equal(Number(afterMinor), Number(beforeMinor) + 1);
  assert.ok(edited.version.endsWith(new Date().toISOString().slice(0, 10)), edited.version);
  assert.deepEqual(edited.body.ru, [
    { h: 'Раздел' },
    { ul: ['Пункт один', 'Пункт два'] },
    { p: 'Обновлённый тестовый текст на русском.' },
  ]);

  // getTerms() reflects the save immediately — no stale cache to invalidate.
  const afterSave = await legalContentService.getTerms();
  assert.equal(afterSave.version, edited.version);
  assert.deepEqual(afterSave.body.en, edited.body.en);

  // The consent digest system — the whole point of this exercise — picks up the edit in
  // the very next call: bundle()'s archived documents.terms and terms_version already
  // reflect the new text, so a registration right after a save would digest-lock and
  // archive exactly what was just saved, not stale content.
  const bundle = await consentService.bundle('provider', 'ru');
  assert.equal(bundle.terms_version, edited.version);
  assert.deepEqual(bundle.documents.terms.body.en, edited.body.en);

  // Privacy is an independent document/version — saving Terms must not touch it.
  assert.equal((await legalContentService.getPrivacy()).version, legacyContent.privacy.version);

  console.log('PASS: legal document editor — parser round-trip on real Terms/Privacy content ' +
    '(ka/ru/en), DB fallback to legal-content.js, empty-language rejection, version auto-bump, ' +
    'and the live consent digest reflects a saved edit immediately with no cache to invalidate');
})().catch((err) => { console.error(err); process.exitCode = 1; });
