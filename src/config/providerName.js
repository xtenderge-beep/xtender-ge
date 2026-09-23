// Display-only transliteration: retain the submitted name in storage and admin.
const russian = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z', и:'i',
  й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t',
  у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};
const georgian = {
  ა:'a', ბ:'b', გ:'g', დ:'d', ე:'e', ვ:'v', ზ:'z', თ:'t', ი:'i', კ:'k',
  ლ:'l', მ:'m', ნ:'n', ო:'o', პ:'p', ჟ:'zh', რ:'r', ს:'s', ტ:'t', უ:'u',
  ფ:'p', ქ:'k', ღ:'gh', ყ:'q', შ:'sh', ჩ:'ch', ც:'ts', ძ:'dz', წ:'ts', ჭ:'ch', ხ:'kh', ჯ:'j', ჰ:'h',
};
const capitalize = value => value ? value[0].toUpperCase() + value.slice(1) : value;
function displayName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[А-ЯЁа-яё]+|[\u10D0-\u10F0\u1C90-\u1CB0]+/gu, word => {
    const lower = word.toLowerCase();
    if (Object.hasOwn(georgian, lower[0])) {
      return capitalize(Array.from(lower, char => georgian[char] ?? char).join(''));
    }
    const uppercase = word === word.toUpperCase();
    return Array.from(word, char => {
      const mapped = russian[char.toLowerCase()] ?? char;
      return uppercase ? mapped.toUpperCase() : char === char.toUpperCase() ? capitalize(mapped) : mapped;
    }).join('');
  });
}
const MAX_OVERRIDE_LENGTH = 120;

// Admin can correct a name the automatic transliteration got wrong (e.g. a rare
// spelling) without touching what the provider actually typed at signup.
function resolve(master) {
  const override = typeof master?.display_name_override === 'string' ? master.display_name_override.trim() : '';
  return override || displayName(master?.name);
}

function validateOverride(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > MAX_OVERRIDE_LENGTH) return null;
  return trimmed; // '' clears the override, reverting to automatic transliteration
}

module.exports = { displayName, resolve, validateOverride, MAX_OVERRIDE_LENGTH };
