const axios = require('axios');

// Машинный перевод текста заявки на ka/ru/en через OpenRouter. Модель выбрана бенчмарком
// (см. HANDOFF / _bench): gemini-2.5-flash-lite — чисто по всем направлениям, ~0.6с,
// ~$0.14 за 1000 заявок. Промпт с глоссарием терминов спецтехники и жёстким правилом:
// адреса/имена/числа не трогать, названия писать в алфавите целевого языка.
//
// Без OPENROUTER_API_KEY сервис работает вхолостую (как sms/telegram в деве) — заявка
// создаётся нормально, везде показывается оригинал.

const MODEL = process.env.OPENROUTER_TRANSLATION_MODEL || 'google/gemini-2.5-flash-lite';
const KEY = process.env.OPENROUTER_API_KEY;
const CALL_TIMEOUT_MS = 6000;

const LANGS = ['ka', 'ru', 'en'];
const LANG_NAME = { ka: 'Georgian', ru: 'Russian', en: 'English' };

// Определение языка оригинала по алфавиту: грузинские буквы → ka, кириллица → ru, иначе en.
function detectLang(text) {
  const s = String(text || '');
  if (/[Ⴀ-ჿ]/.test(s)) return 'ka';
  if (/[Ѐ-ӿ]/.test(s)) return 'ru';
  return 'en';
}

function buildPrompt(text, target) {
  return `You translate short service requests for a Tbilisi marketplace (moving, loaders, junk removal, tow trucks, aerial lifts). Translate the text into ${LANG_NAME[target]}.

HARD RULES:
- Street names, place names, district names, metro stations, personal names, company names, phone numbers and every number/quantity/date/time: reproduce EXACTLY. Never replace a place with a different place. Never drop or change a digit.
- Write place and street names in the target language's script using standard transliteration (Georgian <-> Cyrillic <-> Latin). Do not leave them in the source script.
- Keep the register: casual stays casual, typos stay (but readable). Do not add or invent details.
- Output ONLY the translation - no notes, quotes or explanations.

DOMAIN GLOSSARY (use the correct term):
- tow truck / эвакуатор = ევაკუატორი
- aerial work platform / bucket lift / "жираф" = ავტოამწე (კალათიანი ამწე) / автовышка
- knuckle-boom crane truck = მანიპულატორი / манипулятор
- loaders / movers (no vehicle) = მუშები (დამტვირთავები) / грузчики
- flatbed / open-sided body = ბორტიანი / борт
- enclosed van = დახურული ფურგონი / закрытый фургон
- tail lift / hydraulic lift-gate = ჰიდრობორტი / гидроборт
- slide-back tow platform ("ломаная платформа") = გადამტეხი პლატფორმა
- wheel-lift / partial-load tow ("паук") = ობობა (ნაწილობრივი დატვირთვა)

Text:
${text}`;
}

async function callModel(text, target) {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: MODEL,
      messages: [{ role: 'user', content: buildPrompt(text, target) }],
      temperature: 0.2,
      max_tokens: 1200,
    },
    {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'HTTP-Referer': 'https://xtender.ge',
        'X-Title': 'xtender.ge',
      },
      timeout: CALL_TIMEOUT_MS,
    }
  );
  return (res.data.choices?.[0]?.message?.content || '').trim();
}

// Возвращает { sourceLang, translations: { <lang>: text, ... } } или null.
// translations — только языки, отличные от исходного. Сбой одного языка не роняет
// остальные. НЕ выбрасывает — вызывающий код не должен зависеть от результата.
async function translateOrder(text) {
  if (!KEY) {
    console.log('[translation] пропущено — нет OPENROUTER_API_KEY');
    return null;
  }
  const clean = String(text || '').trim();
  if (!clean) return null;

  const sourceLang = detectLang(clean);
  const targets = LANGS.filter((l) => l !== sourceLang);
  const translations = {};

  await Promise.all(
    targets.map(async (t) => {
      try {
        const out = await callModel(clean, t);
        if (out) translations[t] = out;
      } catch (err) {
        console.error(`[translation] ${sourceLang}->${t} failed:`, err.response?.status || '', err.message);
      }
    })
  );

  if (!Object.keys(translations).length) return null;
  return { sourceLang, translations };
}

module.exports = { translateOrder, detectLang };
