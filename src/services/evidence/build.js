const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');
const chain = require('../consentChain.service');
const subjects = require('./subject');
const labels = require('./labels');
const { redactRow, redactText, maskPhone, jsonSafe } = require('./redact');
const zip = require('./zip');
const { phoneVariants } = require('../../config/phone');

// Архив доказательств по одному субъекту: профилю исполнителя или номеру (записи без доказанной связи с профилем).
// Исходные записи в базе не меняются; в архив идут безопасные копии с перечнем скрытого, полные тексты принятых
// документов из снимков на момент согласия, отрезок цепочки отпечатков и внешние метки времени, скрипт проверки.
// Чего нет — перечисляется в missing.json с причиной; ничего не достраивается.

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const iso = (value) => (value ? new Date(value).toISOString() : null);
const json = (value) => (typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch (_) { return {}; } })() : value) || {};
// С этой даты (выкладка этапа А, 02.11.2026) журнал хранит текст и категорию SMS, историю номера и адрес клиента.
const STAGE_A_DATE = '2026-11-02';
const STAGE_A = new Date('2026-11-02T18:00:00Z');
const SMS_EVENTS = ['SMS_OTP_SENT', 'TX_SMS_SENT', 'LEAD_SMS_SENT', 'SMS_SEND_FAILED', 'LEAD_CHARGE_ACCEPTED'];

function gatewayStatus(row) {
  const metadata = json(row.metadata);
  if (row.event_type === 'SMS_SEND_FAILED') return { code: 'rejected', ru: 'не принято шлюзом', ka: 'შლუზმა არ მიიღო' };
  if (row.event_type === 'SMS_OTP_SENT') return { code: 'accepted', ru: 'принято шлюзом (запись делается только после ответа «принято»)', ka: 'შლუზმა მიიღო' };
  const status = metadata.acceptance_status;
  if (status === 'accepted') return metadata.channel === 'telegram'
    ? { code: 'accepted', ru: 'принято Telegram', ka: 'Telegram-მა მიიღო' } : { code: 'accepted', ru: 'принято шлюзом', ka: 'შლუზმა მიიღო' };
  if (status) return { code: status, ru: 'не принято: ' + status, ka: 'არ მიიღო: ' + status };
  return { code: 'unknown', ru: 'неизвестно (в записи нет ответа)', ka: 'უცნობია' };
}

function deliveryStatus(row, reports, gatewayId) {
  const report = gatewayId ? reports.get(String(gatewayId)) : null;
  if (report) {
    const status = json(report.metadata).delivery_status;
    return { code: status, ru: status === 'delivered' ? 'доставлено (отчёт шлюза)' : 'не доставлено (отчёт шлюза): ' + status, ka: status === 'delivered' ? 'მიწოდებულია' : 'არ მიწოდებულა', report_log_id: Number(report.id) };
  }
  if (json(row.metadata).channel === 'telegram') return { code: 'unknown', ru: 'нет данных: Telegram не сообщает о прочтении', ka: 'მონაცემი არ არის' };
  return { code: 'unknown', ru: 'нет данных: шлюз сообщает только о приёме сообщения, не о доставке', ka: 'მონაცემი არ არის: შლუზი მხოლოდ მიღებას ადასტურებს' };
}

// Текст документа в редакции из снимка. Тело — блоки по языкам (как в редакторе договоров админки); в файл идёт
// язык согласия, остальные языки снимка — ниже, без изменений.
function docText(body, language) {
  const { renderDocBody } = require('../../config/legalTextFormat');
  const one = (value) => (typeof value === 'string' ? value : Array.isArray(value) ? renderDocBody(value) : JSON.stringify(value, null, 2));
  if (!body || typeof body !== 'object' || Array.isArray(body)) return one(body);
  const order = [language, ...Object.keys(body).filter((key) => key !== language)].filter((key) => body[key] !== undefined);
  return order.map((key, index) => (index ? `\n\n===== ${key} =====\n\n` : '') + one(body[key])).join('');
}

// Субъект → записи журнала и сопутствующее.
async function gather(subject, rules) {
  if (subject.type === 'profile') {
    const found = await subjects.profile(subject.id);
    if (!found.master && !found.rows.length) return null;
    const phones = new Set(found.periods.map((period) => subjects.tail(period.phone)).filter(Boolean));
    const admin = (await pool.query('SELECT id, actor, action, body, created_at FROM master_admin_events WHERE master_id = $1 ORDER BY id', [subject.id])).rows
      .map((event) => ({ id: event.id, time: iso(event.created_at), actor: /исполнитель/i.test(event.actor) ? 'исполнитель' : 'сотрудник Xtender', action: event.action,
        body: rules.adminNotes ? event.body : event.body ? '[скрыто]' : '' }));
    const dispatch = (await pool.query(`SELECT order_id, status, reason, channel, created_at, finished_at FROM dispatch_deliveries WHERE master_id = $1 ORDER BY id`, [subject.id])).rows
      .map((item) => ({ order_id: item.order_id, status: item.status, reason: item.reason, channel: item.channel, created_at: iso(item.created_at), finished_at: iso(item.finished_at) }));
    const variants = [...new Set([...phones].flatMap((key) => phoneVariants(`+995${key}`)))];
    // Пустые master_id считаются в коде: тестовая база (pg-mem) ошибается на IS NULL по индексу.
    const onPhones = variants.length ? (await pool.query(`SELECT master_id FROM sms_consent_logs
      WHERE phone_number IN (${variants.map((_, i) => `$${i + 1}`).join(', ')})`, variants)).rows.filter((row) => !row.master_id).length : 0;
    const unlinked = onPhones - found.rows.filter((row) => !row.master_id).length;
    return { kind: 'profile', found, rows: found.rows, links: found.links, phones, admin, dispatch, orders: [], unlinked: Math.max(0, unlinked),
      title: `Профиль #${found.id}${found.name ? ' «' + found.name + '»' : ''}`, phone: found.phone };
  }
  const found = await subjects.phoneSubject(subject.phone);
  return { kind: 'phone', found, rows: found.rows, links: new Map(), phones: new Set([subjects.tail(subject.phone)]), admin: [], dispatch: [],
    orders: found.orders.map((order) => ({ ...jsonSafe(order), description: redactText(order.description, new Set([subjects.tail(subject.phone)])).text })), unlinked: 0,
    title: `Номер ${found.phone}: записи без связи с профилем`, phone: found.phone };
}

// settleMs: записи моложе этого не входят в цепочку при выгрузке (их транзакция могла не завершиться); 5 секунд.
async function build({ subject, purpose, reason, exportId, now = new Date(), settleMs = 5000 }) {
  const rules = labels.PURPOSES[purpose];
  if (!rules) throw new Error('Неизвестная цель выгрузки');
  const data = await gather(subject, rules);
  if (!data) return null;

  // Цепочка: дописать, поставить отпечаток выгрузки с внешней меткой времени, проверить целиком.
  const exportAnchor = await chain.anchor({ kind: 'export', settleMs });
  const fullCheck = await chain.verify();
  const ids = data.rows.map((row) => row.id);
  const linksByLog = new Map();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      (await pool.query(`SELECT seq, log_id, prev_hash, row_hash FROM consent_log_chain WHERE log_id IN (${part.map((_, j) => `$${j + 1}`).join(', ')})`, part)).rows
        .forEach((item) => linksByLog.set(String(item.log_id), item));
    }
  }
  const seqs = [...linksByLog.values()].map((item) => Number(item.seq));
  const fromSeq = seqs.length ? Math.min(...seqs) : exportAnchor ? exportAnchor.seq : 0;
  const toSeq = exportAnchor ? exportAnchor.seq : seqs.length ? Math.max(...seqs) : 0;
  const rangeLinks = toSeq ? (await pool.query('SELECT seq, prev_hash, row_hash FROM consent_log_chain WHERE seq >= $1 AND seq <= $2 ORDER BY seq', [fromSeq, toSeq])).rows
    .map((item) => ({ seq: Number(item.seq), prev_hash: item.prev_hash, row_hash: item.row_hash })) : [];
  const anchors = toSeq ? (await pool.query('SELECT * FROM consent_log_anchors WHERE chain_seq >= $1 AND chain_seq <= $2 ORDER BY id', [fromSeq, toSeq])).rows : [];

  const reportRows = (await pool.query("SELECT * FROM sms_consent_logs WHERE event_type = 'SMS_DELIVERY_REPORT'")).rows;
  const reports = new Map(reportRows.map((row) => [String(row.otp_reference_id), row]));

  // Записи журнала: безопасная копия, звено, пересчёт отпечатка по исходной записи.
  const records = data.rows.map((row) => {
    const item = linksByLog.get(String(row.id));
    const { row: safe, redacted } = redactRow(row, { subjectPhones: data.phones, rules });
    const verified = item ? chain.link(item.prev_hash, row) === item.row_hash : null;
    const label = labels.event(row.event_type);
    return {
      log_id: Number(row.id), time: iso(row.timestamp_utc), event: row.event_type, label_ru: label.ru, label_ka: label.ka, sections: label.sections,
      linked_by: data.links.get(String(row.id)) || (row.master_id ? 'запись профиля (master_id)' : 'запись по номеру'),
      chain: item ? { seq: Number(item.seq), prev_hash: item.prev_hash, row_hash: item.row_hash } : null,
      verified_by_xtender_at_export: verified,
      independently_verifiable: Boolean(item) && redacted.length === 0,
      redacted_fields: redacted,
      row: safe,
      _original: row,
    };
  });

  // Документы: полные тексты из снимков на момент согласия, без замены на нынешнюю редакцию.
  const documents = new Map();
  const documentItems = [];
  for (const record of records) {
    const row = record._original;
    const metadata = json(row.metadata);
    const snapshot = metadata.snapshot;
    const files = [];
    if (snapshot && snapshot.documents) {
      for (const [kind, doc] of Object.entries(snapshot.documents)) {
        if (!doc || !doc.body) continue;
        const language = snapshot.language || row.consent_language || 'ka';
        const name = `documents/${kind}-${doc.version || 'без-версии'}-${language}.txt`;
        if (!documents.has(name)) documents.set(name, docText(doc.body, language));
        files.push({ kind, version: doc.version || null, language, file: name, sha256: sha256(Buffer.from(documents.get(name), 'utf8')) });
      }
    }
    const shown = row.consent_text_snapshot || (snapshot && snapshot.text) || null;
    if (shown) {
      const name = `documents/shown-text-record-${record.log_id}.txt`;
      documents.set(name, shown);
      files.push({ kind: 'shown_text', version: row.terms_version || (snapshot && snapshot.terms_version) || null, language: row.consent_language || (snapshot && snapshot.language) || null, file: name, sha256: sha256(Buffer.from(shown, 'utf8')) });
    }
    if (snapshot && !snapshot.documents && ['CONSENT_SMS_OTP_VERIFIED', 'CLIENT_CONSENT_OTP_VERIFIED'].includes(row.event_type)) {
      files.push({ kind: 'missing', note: 'полный текст договора на момент согласия в записи не сохранён' });
    }
    if (files.length) documentItems.push({ log_id: record.log_id, time: record.time, label_ru: record.label_ru, label_ka: record.label_ka,
      digest: snapshot ? snapshot.digest || null : null, choices: snapshot ? snapshot.choices || null : null, documents: files });
  }

  const section = (key) => records.filter((record) => record.sections.includes(key));
  const brief = (record) => ({ log_id: record.log_id, time: record.time, event: record.event, label_ru: record.label_ru, label_ka: record.label_ka });
  // Сообщения. Отчёт о доставке — не сообщение: он виден в поле delivery того сообщения, к которому относится.
  // Об одной SMS о заявке бывает две записи (отправка и списание) с одним номером сообщения шлюза.
  const smsRecords = section('sms').filter((record) => record.event !== 'SMS_DELIVERY_REPORT');
  const sentByGateway = new Map(smsRecords.filter((record) => record.event !== 'LEAD_CHARGE_ACCEPTED' && record._original.otp_reference_id)
    .map((record) => [String(record._original.otp_reference_id), record]));
  const sms = smsRecords.map((record) => {
    const row = record._original;
    const metadata = json(row.metadata);
    const rawText = metadata.message_text || metadata.message_body || null;
    const gatewayId = row.otp_reference_id || metadata.provider_message_id || null;
    const sibling = !rawText && gatewayId ? sentByGateway.get(String(gatewayId)) : null;
    const textNote = rawText ? null : sibling && sibling.log_id !== record.log_id ? `текст — в записи об отправке #${sibling.log_id}`
      : row.message_body_hash ? `текст не хранился (до ${STAGE_A_DATE}), есть отпечаток SHA-256 текста` : 'текст не записан';
    return { ...brief(record), channel: metadata.channel || 'sms', category: row.event_type === 'LEAD_CHARGE_ACCEPTED' ? 'lead' : metadata.category || (row.event_type === 'SMS_OTP_SENT' ? 'code' : row.event_type === 'LEAD_CHARGE_ACCEPTED' || row.event_type === 'LEAD_SMS_SENT' ? 'lead' : null),
      text: rawText ? redactText(rawText, data.phones).text : null, text_note: textNote, text_sha256: row.message_body_hash || null,
      gateway: gatewayStatus(row), gateway_message_id: gatewayId, delivery: deliveryStatus(row, reports, gatewayId),
      ...(row.event_type === 'LEAD_CHARGE_ACCEPTED' ? { service_category: metadata.category || null } : {}) };
  });
  const consents = section('consents').map((record) => {
    const row = record._original;
    const metadata = json(row.metadata);
    return { ...brief(record), actor: metadata.actor || null, source: metadata.source || null, reason: metadata.reason || null,
      choices: metadata.snapshot ? metadata.snapshot.choices || null : null, text_version: row.terms_version || null, language: row.consent_language || null,
      text_file: (documentItems.find((item) => item.log_id === record.log_id)?.documents || []).find((doc) => doc.kind === 'shown_text')?.file || null };
  });
  const optouts = section('optouts').map((record) => {
    const metadata = json(record._original.metadata);
    return { ...brief(record), actor: metadata.actor || null, source: metadata.source || null, reason: metadata.reason || null, unopened_order_ids: metadata.unopened_order_ids || null };
  });
  const otp = section('otp').map((record) => ({ ...brief(record), purpose: record._original.purpose || null, ip: record.row.ip_address || null, user_agent: record.row.user_agent || null,
    gateway_message_id: record._original.otp_reference_id || null }));
  const subjectSection = {
    title: data.title,
    profile: data.kind === 'profile' ? {
      id: data.found.id, name: data.found.name, exists: Boolean(data.found.master), deleted_at: iso(data.found.deletedAt),
      created_at: iso(data.found.master?.created_at), terms_accepted_at: iso(data.found.master?.terms_accepted_at),
      registration_language: data.found.master?.registration_language || null,
      state: data.found.master ? { active: data.found.master.is_active, banned: data.found.master.is_banned, receives_requests: data.found.master.is_subscribed,
        offers: data.found.master.marketing_sms === true, paused_since: iso(data.found.master.lead_sms_paused_at) } : null,
    } : null,
    phone_periods: data.kind === 'profile' ? data.found.periods.map((period) => ({ phone: period.phone, from: iso(period.from), to: iso(period.to),
      recorded_in_journal: period.recorded, how_known: period.how })) : null,
    other_profiles_on_this_phone: data.kind === 'phone' ? data.found.profiles.map((item) => ({ profile_id: item.id,
      periods: item.usage.map((period) => ({ from: iso(period.from), to: iso(period.to), how_known: period.how })),
      note: 'отдельный профиль; его записи в этот архив не входят; что это тот же человек, журнал не доказывает' })) : null,
    events: section('subject').map(brief),
    admin_actions: data.admin,
    admin_actions_note: 'рабочий журнал действий с профилем (изменяемая таблица, не защищена цепочкой); до 02.11.2026 отказы от заявок записывались только здесь',
    dispatch: data.dispatch,
    dispatch_note: 'рабочая таблица рассылки (не журнал): кому и когда отправлялась заявка, причина пропуска; тексты заявок не включены',
  };

  // Чего нет и почему.
  const journalStart = (await pool.query('SELECT MIN(timestamp_utc) AS t FROM sms_consent_logs')).rows[0].t;
  const chainStart = (await pool.query('SELECT MIN(chained_at) AS t FROM consent_log_chain')).rows[0].t;
  const missing = [];
  const add = (code, ru, ka, extra = {}) => missing.push({ code, ru, ka, ...extra });
  add('journal_start', `Журнал согласий ведётся с ${iso(journalStart)?.slice(0, 10)}. Более ранних записей нет ни у кого.`, `თანხმობების ჟურნალი იწარმოება ${iso(journalStart)?.slice(0, 10)}-დან.`);
  if (data.kind === 'profile' && !data.rows.some((row) => row.event_type === 'MASTER_REGISTERED')) add('no_registration', 'Записи о регистрации профиля в журнале нет (профиль создан до журнала или вручную).', 'პროფილის რეგისტრაციის ჩანაწერი ჟურნალში არ არის.');
  const unrecorded = (subjectSection.phone_periods || []).filter((period) => !period.recorded_in_journal);
  if (unrecorded.length) add('phone_history', `История номера записывается с ${STAGE_A_DATE}. Периоды номеров без записи о смене (${unrecorded.length}) восстановлены по фактам и так помечены.`, `ნომრის ისტორია იწერება ${STAGE_A_DATE}-დან.`, { periods: unrecorded });
  const noText = sms.filter((item) => !item.text && !/в записи об отправке/.test(item.text_note)).length;
  if (noText) add('sms_text', `Текст ${noText} сообщений не хранился (журнал хранит текст с ${STAGE_A_DATE}); где записан, есть отпечаток SHA-256 текста.`, `${noText} შეტყობინების ტექსტი არ ინახებოდა.`);
  const noReport = sms.filter((item) => item.delivery.code === 'unknown').length;
  if (noReport) add('delivery', `Для ${noReport} из ${sms.length} сообщений отчёта о доставке нет: шлюз SMS (CityNet) сообщает только о приёме, Telegram — только о приёме сервером. «Принято» не означает «доставлено» или «прочитано».`, `${noReport} შეტყობინებაზე მიწოდების ანგარიში არ არის: შლუზი მხოლოდ მიღებას ადასტურებს.`);
  const oldIp = records.filter((record) => new Date(record.time) < STAGE_A && record._original.ip_address).length;
  if (oldIp) add('ip_before_stage_a', `В ${oldIp} записях до ${STAGE_A_DATE} поле ip_address — адрес прокси сервера, а не человека. Адрес человека — первый слева в x_forwarded_for.`, `${STAGE_A_DATE}-მდე ip_address არის პროქსის მისამართი.`);
  add('chain_start', `Цепочка отпечатков ведётся с ${iso(chainStart)?.slice(0, 19)}: она доказывает, что записи не менялись с этого момента, но не раньше.`, `ანაბეჭდების ჯაჭვი იწარმოება ${iso(chainStart)?.slice(0, 10)}-დან.`);
  const unchained = records.filter((record) => !record.chain).length;
  if (unchained) add('not_in_chain_yet', `${unchained} записей моложе минуты ещё не вошли в цепочку на момент выгрузки.`, `${unchained} ჩანაწერი ჯერ არ შესულა ჯაჭვში.`);
  if (data.unlinked) add('unlinked_phone_records', `По номерам профиля есть ${data.unlinked} записей без доказанной связи с профилем (коды без регистрации, заявки заказчика). В этот архив не включены; выгружаются архивом по номеру.`, `${data.unlinked} ჩანაწერი პროფილთან კავშირის გარეშე ამ არქივში არ შედის.`);
  const noDocs = documentItems.filter((item) => item.documents.some((doc) => doc.kind === 'missing')).length;
  if (noDocs) add('documents', `В ${noDocs} согласиях полный текст договора на момент согласия не сохранён.`, `${noDocs} თანხმობაში ხელშეკრულების სრული ტექსტი არ ინახება.`);
  if (data.kind === 'profile' && !data.found.master) add('deleted_profile', 'Профиль удалён: данных профиля в базе нет, остались только записи журнала.', 'პროფილი წაშლილია: დარჩა მხოლოდ ჟურნალის ჩანაწერები.');

  // Отпечатки и метки времени.
  const anchorFiles = [];
  for (const anchor of anchors) {
    const base = `anchors/anchor-${anchor.id}`;
    const info = { id: Number(anchor.id), kind: anchor.kind, created_at: iso(anchor.created_at), chain_seq: Number(anchor.chain_seq), chain_head: anchor.chain_head,
      log_rows: Number(anchor.log_rows), sent_to: anchor.sent_to, tsa_url: anchor.tsa_url || null, tsa_time: iso(anchor.tsa_time), tsa_file: anchor.tsa_response ? `anchor-${anchor.id}.tsr` : null };
    anchorFiles.push({ name: base + '.json', data: JSON.stringify(info, null, 2) });
    if (anchor.tsa_response) anchorFiles.push({ name: base + '.tsr', data: Buffer.from(anchor.tsa_response, 'base64') });
  }

  const recordsOut = records.map(({ _original, ...rest }) => rest);
  const verifiedCount = records.filter((record) => record.verified_by_xtender_at_export === true).length;
  const mismatch = records.filter((record) => record.verified_by_xtender_at_export === false);
  const checks = [
    { check: 'Пересчёт отпечатков записей архива по исходным записям в базе', performed: true,
      result: mismatch.length ? `РАСХОЖДЕНИЕ: ${mismatch.length} записей (${mismatch.map((record) => '#' + record.log_id).join(', ')})` : `сошлось: ${verifiedCount} из ${records.length}${unchained ? `, ${unchained} ещё не в цепочке` : ''}` },
    { check: 'Проверка всей цепочки журнала с первого звена', performed: true,
      result: fullCheck.ok ? `цела: ${fullCheck.checked} звеньев, ${fullCheck.anchors} отпечатков` : `НАРУШЕНА: ${fullCheck.problems.map((p) => (p.seq ? 'звено ' + p.seq : 'отпечаток ' + p.anchor) + ' — ' + p.problem).join('; ')}` },
    { check: 'Отпечаток выгрузки с внешней меткой времени (RFC 3161)', performed: true,
      result: exportAnchor && exportAnchor.tsa ? `получен: ${exportAnchor.tsa.url}, ${iso(exportAnchor.tsa.time)}; статус «выдано», в метке наш отпечаток и наш одноразовый номер` : exportAnchor ? 'метку получить не удалось: служба времени не ответила; отпечаток сохранён только в базе' : 'цепочка журнала пуста: отпечаток не создан' },
    { check: 'Подпись службы времени', performed: false, result: 'Xtender подпись не проверяет: её проверяет получатель командой openssl из README, по корневому сертификату службы' },
    { check: 'Суточные отпечатки в Telegram', performed: false, result: `отправлено отпечатков: ${anchors.filter((a) => a.sent_to === 'telegram').length}; что сообщения остались в чате, Xtender подтвердить не может` },
    { check: 'Доставка SMS', performed: false, result: 'не проверяется: шлюз не даёт отчётов о доставке' },
    { check: 'SHA-256 каждого файла архива', performed: true, result: 'вычислены при выгрузке, записаны в integrity.json' },
  ];

  const manifest = {
    archive: 'Xtender — архив доказательств / მტკიცებულებების არქივი',
    export_id: exportId, created_at: now.toISOString(), purpose, purpose_ru: rules.ru, purpose_ka: rules.ka, reason,
    exported_by: 'администратор Xtender (вход по паролю и коду из SMS, повторный код на эту выгрузку)',
    operator: 'ИП Артур Беджанян (ი/მ არტურ ბეჯანიანი), код 304829194, xtender.ge',
    subject: subject.type === 'profile' ? { type: 'profile', id: subject.id } : { type: 'phone', phone: data.phone },
    title: data.title,
    counts: { journal_records: records.length, sms: sms.length, consents: consents.length, optouts: optouts.length, documents: documents.size, orders: data.orders.length, missing: missing.length },
    disclosure_rules: [...labels.RULES, ...(rules.adminNotes ? [] : [{ ru: 'Тексты внутренних заметок сотрудников скрыты.', ka: 'თანამშრომლების შიდა ჩანაწერები დამალულია.' }]),
      ...(rules.holderDevice ? [] : [{ ru: 'IP и устройство того, кто нажал Stop по ссылке из SMS, скрыты: это мог быть другой держатель номера.', ka: 'Stop-ზე დამჭერის IP და მოწყობილობა დამალულია.' }]),
      ...(rules.hideExportReasons ? [{ ru: 'Причины прошлых выгрузок скрыты; виден сам факт выгрузки.', ka: 'წინა ექსპორტების მიზეზები დამალულია; ჩანს მხოლოდ ექსპორტის ფაქტი.' }] : [])],
    export_anchor: exportAnchor ? { id: exportAnchor.id, chain_seq: exportAnchor.seq, chain_head: exportAnchor.head, tsa: exportAnchor.tsa ? { url: exportAnchor.tsa.url, time: iso(exportAnchor.tsa.time) } : null } : null,
    code_version: process.env.RAILWAY_GIT_COMMIT_SHA || null,
  };

  const out = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'missing.json', data: JSON.stringify(missing, null, 2) },
    { name: 'data/journal-records.json', data: JSON.stringify({ note: 'Безопасные копии записей журнала sms_consent_logs. row — запись; redacted_fields — что скрыто; chain — звено цепочки.', records: recordsOut }, null, 2) },
    { name: `data/${labels.SECTIONS.subject.file}.json`, data: JSON.stringify(subjectSection, null, 2) },
    { name: `data/${labels.SECTIONS.otp.file}.json`, data: JSON.stringify(otp, null, 2) },
    { name: `data/${labels.SECTIONS.documents.file}.json`, data: JSON.stringify(documentItems, null, 2) },
    { name: `data/${labels.SECTIONS.consents.file}.json`, data: JSON.stringify(consents, null, 2) },
    { name: `data/${labels.SECTIONS.sms.file}.json`, data: JSON.stringify(sms, null, 2) },
    { name: `data/${labels.SECTIONS.optouts.file}.json`, data: JSON.stringify(optouts, null, 2) },
    ...(data.kind === 'phone' ? [{ name: `data/${labels.SECTIONS.orders.file}.json`, data: JSON.stringify({ orders: data.orders, events: section('orders').map(brief) }, null, 2) }] : []),
    { name: 'data/7-integrity.json', data: JSON.stringify({ checks_performed: checks, chain_full_check: { ok: fullCheck.ok, links: fullCheck.checked, anchors: fullCheck.anchors, problems: fullCheck.problems } }, null, 2) },
    { name: 'integrity/chain-links.json', data: JSON.stringify({ note: 'Звенья цепочки подряд: от первой записи архива до отпечатка выгрузки. Только отпечатки, без содержания чужих записей.', from_seq: fromSeq, to_seq: toSeq, links: rangeLinks }, null, 2) },
    ...anchorFiles,
    ...[...documents.entries()].map(([name, text]) => ({ name, data: text })),
    { name: 'verify.js', data: fs.readFileSync(path.join(__dirname, 'archive-verify.js')) },
  ];
  out.push({ name: 'README.txt', data: readme(manifest, checks) });
  out.push({ name: 'summary.html', data: summary({ manifest, subjectSection, records, sms, missing, checks }) });
  const hashes = Object.fromEntries(out.map((file) => [file.name, sha256(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8'))]));
  out.push({ name: 'integrity.json', data: JSON.stringify({ algorithm: 'SHA-256', note: 'Отпечаток каждого файла архива. Сам этот файл защищён отпечатком всего архива, записанным в журнал выгрузок Xtender и заверенным меткой времени.', files: hashes, checks_performed: checks }, null, 2) });
  const archive = zip.build(out, now);
  return { archive, sha256: sha256(archive), files: out.map((file) => file.name), manifest, checks, missing, phone: data.phone, title: data.title };
}

function readme(manifest, checks) {
  return [
    'XTENDER — АРХИВ ДОКАЗАТЕЛЬСТВ / მტკიცებულებების არქივი',
    '',
    `Выгрузка ${manifest.export_id}, ${manifest.created_at}. ${manifest.title}.`,
    `Цель: ${manifest.purpose_ru}. Причина: ${manifest.reason}`,
    '',
    'ЧТО ВНУТРИ',
    '  summary.html            — сводка на грузинском и русском, открывается в браузере',
    '  data/journal-records.json — записи журнала (безопасные копии) со звеньями цепочки',
    '  data/1-…6-*.json        — разделы: профиль и номера, коды, документы, согласия, сообщения, отписки',
    '  documents/              — полные тексты принятых документов в редакции на момент принятия',
    '  missing.json            — чего нет и почему',
    '  integrity/, anchors/    — отрезок цепочки отпечатков, отпечатки с метками времени (.tsr)',
    '  integrity.json          — SHA-256 каждого файла и выполненные при выгрузке проверки',
    '  verify.js               — самостоятельная проверка: node verify.js',
    '',
    'КАК ПРОВЕРИТЬ БЕЗ XTENDER',
    '  1. node verify.js — файлы, записи журнала, звенья цепочки, совпадение отпечатков с метками.',
    '  2. Метка времени: openssl ts -verify -in anchors/<файл>.tsr -digest <chain_head из anchors/<файл>.json> -CAfile <корень>',
    '     Корень DigiCert: https://cacerts.digicert.com/DigiCertTrustedRootG4.crt.pem',
    '     Корень FreeTSA:  https://freetsa.org/files/cacert.pem',
    '     «Verification: OK» означает: служба времени подписала этот отпечаток в указанное время; запись в цепочке',
    '     не могла появиться или измениться после этого без расхождения отпечатков.',
    '  3. Отпечаток SHA-256 всего архива записан в журнал выгрузок Xtender и заверен отдельной меткой времени;',
    '     Xtender предоставляет её по запросу вместе с архивом.',
    '',
    'ВЫПОЛНЕННЫЕ ПРИ ВЫГРУЗКЕ ПРОВЕРКИ',
    ...checks.map((check) => `  [${check.performed ? 'выполнено' : 'не выполнялось'}] ${check.check}: ${check.result}`),
    '',
    'ПРАВИЛА РАСКРЫТИЯ',
    ...manifest.disclosure_rules.map((rule) => '  - ' + rule.ru),
    '',
  ].join('\n');
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const tbilisi = (value) => (value ? new Date(new Date(value).getTime() + 4 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—');

function summary({ manifest, subjectSection, records, sms, missing, checks }) {
  const smsById = new Map(sms.map((item) => [item.log_id, item]));
  const rows = records.map((record) => {
    const item = smsById.get(record.log_id);
    const detail = record.event === 'SMS_DELIVERY_REPORT' ? escapeHtml(json(record.row.metadata).delivery_status || '') : item ?`${escapeHtml(item.text || item.text_note)}<br><small>${escapeHtml(item.gateway.ka)} / ${escapeHtml(item.gateway.ru)}; ${escapeHtml(item.delivery.ru)}</small>` : '';
    return `<tr><td>${tbilisi(record.time)}</td><td>#${record.log_id}</td><td>${escapeHtml(record.label_ka)}<br><small>${escapeHtml(record.label_ru)}</small></td><td>${detail}</td><td>${record.verified_by_xtender_at_export === true ? '✓' : record.verified_by_xtender_at_export === false ? '✗' : '—'}${record.redacted_fields.length ? ' <small>скрыто: ' + escapeHtml(record.redacted_fields.join(', ')) + '</small>' : ''}</td></tr>`;
  }).join('\n');
  const periods = (subjectSection.phone_periods || []).map((period) => `<li>${escapeHtml(period.phone)}: ${tbilisi(period.from)} — ${period.to ? tbilisi(period.to) : 'по сей день'}. ${escapeHtml(period.how_known)}${period.recorded_in_journal ? '' : ' <b>(не записано в журнале)</b>'}</li>`).join('');
  const others = (subjectSection.other_profiles_on_this_phone || []).map((item) => `<li>Профиль #${item.profile_id}: ${item.periods.map((period) => `${tbilisi(period.from)} — ${period.to ? tbilisi(period.to) : 'по сей день'}`).join('; ')}. ${escapeHtml(item.note)}</li>`).join('');
  return `<!DOCTYPE html><html lang="ka"><head><meta charset="utf-8"><title>Xtender — ${escapeHtml(manifest.title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1c1917}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d6d3d1;padding:6px;vertical-align:top;text-align:left}small{color:#57534e}h2{margin-top:28px}</style></head><body>
<h1>მტკიცებულებების არქივი / Архив доказательств</h1>
<p><b>${escapeHtml(manifest.title)}</b><br>${escapeHtml(manifest.operator)}<br>Выгрузка ${escapeHtml(manifest.export_id)}, ${tbilisi(manifest.created_at)} (Тбилиси)<br>
მიზანი / Цель: ${escapeHtml(manifest.purpose_ka)} / ${escapeHtml(manifest.purpose_ru)}<br>Причина: ${escapeHtml(manifest.reason)}</p>
${periods ? `<h2>ნომრები და პერიოდები / Номера и периоды</h2><ul>${periods}</ul>` : ''}
${others ? `<h2>სხვა პროფილები ამ ნომერზე / Другие профили на этом номере</h2><ul>${others}</ul>` : ''}
<h2>ქრონოლოგია / Хронология (время Тбилиси)</h2>
<table><tr><th>Время</th><th>Запись</th><th>მოვლენა / Событие</th><th>Подробности</th><th>Отпечаток</th></tr>
${rows}</table>
<h2>რა არ არის და რატომ / Чего нет и почему</h2><ul>${missing.map((item) => `<li>${escapeHtml(item.ka)}<br>${escapeHtml(item.ru)}</li>`).join('')}</ul>
<h2>შემოწმებები / Проверки при выгрузке</h2><ul>${checks.map((check) => `<li>[${check.performed ? 'выполнено' : 'не выполнялось'}] ${escapeHtml(check.check)}: ${escapeHtml(check.result)}</li>`).join('')}</ul>
<h2>გამჟღავნების წესები / Правила раскрытия</h2><ul>${manifest.disclosure_rules.map((rule) => `<li>${escapeHtml(rule.ka)}<br>${escapeHtml(rule.ru)}</li>`).join('')}</ul>
<p><small>Самостоятельная проверка: README.txt, node verify.js.</small></p></body></html>`;
}

module.exports = { build, gather };
