const axios = require('axios');
const orderService = require('./order.service');
const managerService = require('./manager.service');
const { getBaseUrl } = require('../config/url');

const API_BASE = 'https://api.telegram.org/bot';
// Буквы и их порядок — src/config/serviceTypes.js (фиксированы, см. CHECK-констрейнты
// в schema.sql). Что каждая буква значит в см — settings.service.getVanSizeThresholds
// (админ может поменять из /admin/categories/van без деплоя), поэтому SIZE_SPECS
// считаем за запрос в buildKeyboardWithCounts, а не тут константой при старте.
const { VAN_SIZE_ORDER, vanSizeSpec } = require('../config/serviceTypes');
const SIZE_LABELS = Object.fromEntries(VAN_SIZE_ORDER.map(code => [code, code]));
const SIZE_ORDER = VAN_SIZE_ORDER;
const CATEGORY_LABELS = {
  transport: '🚚 Перевозки',
  movers: '💪 Грузчики',
  junk: '🧹 Вывоз мусора (самосвал)',
  flatbed: '🚛 Бортовые / стройматериалы',
  tow: '🛻 Эвакуатор',
  bucket_lift: '🏗️ Автовышка',
};

const ADMIN_MENU_KEYBOARD = {
  keyboard: [[{ text: '💰 Пополнить баланс' }, { text: '🔍 Проверить баланс' }]],
  resize_keyboard: true,
};
const FORCE_REPLY = { force_reply: true };
const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Отправить номер', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

function isEnabled() {
  if (process.env.NODE_ENV === 'development') return false;
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

// Кому слать модераторские сообщения: env-модератор (`TELEGRAM_MODERATOR_CHAT_ID`,
// если задан — необязателен) + все активные менеджеры с is_moderator и привязанным
// Telegram. Строками, дедуп. Пусто → заявки/уведомления никуда не уходят (не падение).
async function getModeratorChatIds() {
  const ids = new Set();
  if (process.env.TELEGRAM_MODERATOR_CHAT_ID) ids.add(String(process.env.TELEGRAM_MODERATOR_CHAT_ID));
  try {
    (await managerService.listActiveModeratorChatIds()).forEach((id) => ids.add(String(id)));
  } catch (err) {
    console.error('getModeratorChatIds:', err.message);
  }
  return [...ids];
}

function apiUrl(method) {
  return `${API_BASE}${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function buildKeyboardWithCounts(token, page = 0) {
  const order = await orderService.getOrderByToken(token);
  const counts = await orderService.getMasterCountsByCategory(order?.is_technical === true);

  const total = (category) =>
    counts.filter((row) => row.category === category).reduce((sum, row) => sum + row.count, 0);

  const transportSizes = counts
    .filter((row) => row.category === 'transport' && row.vehicle_size)
    .sort((a, b) => SIZE_ORDER.indexOf(a.vehicle_size) - SIZE_ORDER.indexOf(b.vehicle_size));
  const sizeThresholds = transportSizes.length ? await require('./settings.service').getVanSizeThresholds() : [];
  const sizeSpec = (code) => vanSizeSpec(code, sizeThresholds);

  const groups = await require('./category.service').groups();
  const entries = Object.entries(groups);
  const pages = Math.max(1, Math.ceil(entries.length / 20));
  page = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, pages - 1)) : 0;
  const visible = entries.slice(page * 20, (page + 1) * 20);
  const rows = visible.map(([key,label]) => [{text: label+' ('+total(key)+')', callback_data: 'cat:'+token+':'+key}]);
  if (visible.some(([key])=>key==='transport') && transportSizes.length) {
    transportSizes.forEach((row) => {
      rows.push([
        {
          text: `🚚 ${row.vehicle_size} ${sizeSpec(row.vehicle_size)} (${row.count})`,
          callback_data: `cat:${token}:transport:${row.vehicle_size}`,
        },
      ]);
    });
  }

  rows.forEach(row => row.forEach(button => {
    if (button.callback_data) {
      const parts = button.callback_data.split(':');
      while (parts.length < 4) parts.push('');
      button.callback_data = parts.join(':') + ':' + (order?.revision_version || 0);
    }
  }));
  if (pages > 1) {
    const navigation=[];
    if (page > 0) navigation.push({text:'← Назад',callback_data:'cats_page:'+token+':'+(page-1)});
    if (page < pages-1) navigation.push({text:'Далее →',callback_data:'cats_page:'+token+':'+(page+1)});
    rows.push(navigation);
  }
  rows.push([{ text: '🔄 Обновить категории', callback_data: 'cats_refresh:'+token }]);
  rows.push([{ text: '✏️ Проверить / вернуть на доработку', url: getBaseUrl() + '/admin/orders/' + encodeURIComponent(token) }]);
  return { inline_keyboard: rows };
}

// Модератору показываем русский перевод (если заявка не на русском) + строку оригинала.
// Перевод может не успеть/не быть — тогда просто оригинал.
function moderatorDescription(order) {
  const trs = order.description_translations || {};
  if (order.source_lang && order.source_lang !== 'ru' && trs.ru) {
    return `${trs.ru}\n\n🔤 оригинал (${order.source_lang}): ${order.description}`;
  }
  return order.description;
}

async function notifyModerator(order) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] order ${order.token} pending moderation: ${order.description}`);
    return null;
  }

  const base = getBaseUrl();
  const text = [
    order.is_technical ? '🧪 ТЕСТ — только техническим исполнителям' : '🆕 Новая заявка на модерацию',
    '',
    moderatorDescription(order),
    '',
    `📍 ${order.district_name || '—'}`,
    `📞 ${order.phone}`,
    `🔗 ${base}/order/${order.token}`,
    '',
    'Можно нажимать несколько кнопок — каждая шлёт заявку своей категории.',
  ].join('\n');
  const keyboard = await buildKeyboardWithCounts(order.token);

  // Фото к заявке — публичные URL, Telegram сам их подтянет (как чеки на пополнение).
  const files = await orderService.getOrderFiles(order.id).catch(() => []);
  const photos = files.filter((f) => f.mime_type && f.mime_type.startsWith('image/')).slice(0, 10);
  const docs = files.filter((f) => !photos.includes(f));

  const chatIds = await getModeratorChatIds();
  const sent = [];
  for (const chatId of chatIds) {
    try {
      const { data } = await axios.post(apiUrl('sendMessage'), { chat_id: chatId, text, reply_markup: keyboard });
      sent.push({ chatId, messageId: data.result.message_id });
    } catch (err) {
      console.error(`notifyModerator -> ${chatId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    }
    try {
      if (photos.length === 1) {
        await axios.post(apiUrl('sendPhoto'), { chat_id: chatId, photo: base + photos[0].file_path, caption: `📎 Фото к заявке #${order.id}` });
      } else if (photos.length > 1) {
        await axios.post(apiUrl('sendMediaGroup'), {
          chat_id: chatId,
          media: photos.map((p, i) => ({ type: 'photo', media: base + p.file_path, ...(i === 0 ? { caption: `📎 Фото к заявке #${order.id}` } : {}) })),
        });
      }
      for (const d of docs) {
        await axios.post(apiUrl('sendDocument'), { chat_id: chatId, document: base + d.file_path, caption: `📎 ${d.original_name}` });
      }
    } catch (err) {
      console.error(`notifyModerator photos -> ${chatId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
  if (sent.length) await orderService.recordModerationMessages(order.id, sent);
  return sent.length ? sent[0].messageId : null; // legacy orders.moderation_message_id
}

const MASTER_CATEGORY_LABELS = {
  movers: '💪 Грузчик / разнорабочий',
  transport: '🚚 Водитель',
  junk: '🧹 Вывоз мусора (самосвал)',
};

async function notifyModeratorNewMaster(master) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] new master registration: ${master.name} ${master.phone}`);
    return null;
  }

  const lines = [
    '🆕 Новая регистрация исполнителя',
    '',
    `👤 ${master.name}`,
    `📞 ${master.phone}`,
    `${MASTER_CATEGORY_LABELS[master.category] || master.category || 'Категорию назначит модератор'}`,
  ];
  if (master.vehicle_type) lines.push(`🚙 ${master.vehicle_type}${master.vehicle_size ? ' (' + master.vehicle_size + ')' : ''}`);
  if (master.description) lines.push(`📝 ${master.description}`);
  lines.push(master.referral_manager_name ? `🔗 По ссылке: ${master.referral_manager_name}` : '🔗 Без реферальной ссылки (органика)');
  const text = lines.join('\n');
  const btnText = '📝 Проверить анкету и назначить категорию';
  const adminMarkup = { inline_keyboard: [[{ text: btnText, url: getBaseUrl() + '/admin/masters/' + master.id }]] };

  // Маршрутизация: реферальная регистрация (referral_manager_id уже проставлен при
  // регистрации, см. partner.service.bindNew) идёт ТОЛЬКО владельцу ссылки — остальным
  // модераторам она не по адресу, нечего им её и показывать. Органическая (без ссылки)
  // — как раньше, всем активным модераторам (кто первый одобрит, тот и берёт). Если
  // владелец ссылки сам не может получить Telegram-уведомление (не модератор /
  // выключен / Telegram не привязан) — не теряем заявку, откатываемся на рассылку всем.
  // Главные модераторы (is_head_moderator) получают КАЖДУЮ регистрацию дополнительно,
  // независимо от маршрутизации выше — их не подменяет реферальная адресность.
  let targets;
  if (master.referral_manager_id) {
    const owner = await managerService.getById(master.referral_manager_id);
    targets = owner && owner.is_moderator && owner.is_active && owner.telegram_id
      ? [owner]
      : await managerService.listActiveModerators();
  } else {
    targets = await managerService.listActiveModerators();
  }
  for (const head of await managerService.listHeadModerators()) {
    if (!targets.some((m) => m.id === head.id)) targets.push(head);
  }

  // Каждому — личная одноразовая ссылка: открывает его СОБСТВЕННУЮ сессию без пароля
  // и сразу карточку одобрения этого исполнителя (см. managerPortal.service.
  // issueMagicLink + /manager/auth/:token). Кто одобрит через неё — тот и становится
  // manager_id (см. approvePending), поэтому ссылка должна однозначно определять
  // личность, а не вести в общий /admin. Без веб-доступа (ещё не выдан логин в
  // /admin/managers/:id) — старая общая ссылка.
  let firstId = null;
  const seenChatIds = new Set();
  const managerPortalService = require('./managerPortal.service');
  for (const moderator of targets) {
    const chatId = String(moderator.telegram_id);
    seenChatIds.add(chatId);
    let markup = adminMarkup;
    if (moderator.web_enabled) {
      try {
        const magicToken = await managerPortalService.issueMagicLink(moderator.id, master.id);
        markup = { inline_keyboard: [[{ text: btnText, url: getBaseUrl() + '/manager/auth/' + magicToken }]] };
      } catch (err) {
        console.error('notifyModeratorNewMaster -> issueMagicLink:', err.message);
      }
    }
    try {
      const { data } = await axios.post(apiUrl('sendMessage'), { chat_id: chatId, text, reply_markup: markup });
      if (!firstId) firstId = data.result.message_id;
    } catch (err) {
      console.error(`notifyModeratorNewMaster -> ${chatId}:`, err.message);
    }
  }
  // env-модератор (TELEGRAM_MODERATOR_CHAT_ID) не привязан к строке managers — для
  // него личной ссылки не построить, шлём как раньше, на общий /admin.
  const envChatId = process.env.TELEGRAM_MODERATOR_CHAT_ID ? String(process.env.TELEGRAM_MODERATOR_CHAT_ID) : null;
  if (envChatId && !seenChatIds.has(envChatId)) {
    try {
      const { data } = await axios.post(apiUrl('sendMessage'), { chat_id: envChatId, text, reply_markup: adminMarkup });
      if (!firstId) firstId = data.result.message_id;
    } catch (err) {
      console.error(`notifyModeratorNewMaster -> ${envChatId}:`, err.message);
    }
  }
  return firstId;
}

async function confirmMasterApproved(chatId, messageId, master) {
  if (!isEnabled()) return;
  await axios
    .post(apiUrl('editMessageText'), {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ Одобрено\n\n👤 ${master.name}\n📞 ${master.phone}`,
    })
    .catch((err) => {
      console.error('Failed to update master approval message:', err.message);
    });
}

async function sendTopupReceipt(master, fileUrl, isImage) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] topup receipt from ${master.name} ${master.phone}: ${fileUrl}`);
    return;
  }

  const caption = [
    '💳 Чек на пополнение баланса',
    '',
    `👤 ${master.name}`,
    `📞 ${master.phone}`,
    `💰 Баланс сейчас: ${(master.balance_tetri / 100).toFixed(2)} GEL`,
    '',
    `Сверьте с поступлением на счёт в банке (сумма + номер ${master.phone} в комментарии перевода). ` +
      'Чек — не основание: начисляйте только после того, как увидели деньги на счёте, через «💰 Пополнить баланс».',
  ].join('\n');

  const method = isImage ? 'sendPhoto' : 'sendDocument';
  for (const chatId of await getModeratorChatIds()) {
    const body = { chat_id: chatId, caption };
    body[isImage ? 'photo' : 'document'] = fileUrl;
    await axios.post(apiUrl(method), body).catch((err) => {
      console.error(`sendTopupReceipt -> ${chatId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    });
  }
}

// Широковещательно всем модераторам («что-то произошло»: пополнение, ошибка и т.п.).
// Ответ на конкретную команду шли в chatId адресата через sendToChat.
async function sendMessageToModerator(text, replyMarkup = ADMIN_MENU_KEYBOARD) {
  if (!isEnabled()) return;
  for (const chatId of await getModeratorChatIds()) {
    await axios
      .post(apiUrl('sendMessage'), { chat_id: chatId, text, reply_markup: replyMarkup })
      .catch((err) => console.error(`sendMessageToModerator -> ${chatId}:`, err.message));
  }
}

// force_reply-приглашение конкретному модератору (внутри пошагового флоу).
async function askModerator(chatId, text) {
  return sendToChat(chatId, text, FORCE_REPLY);
}

// Оповещение о событиях безопасности /admin (вход, подозрение на перебор пароля) —
// намеренно ТОЛЬКО в env-модератора (владелец), не всем менеджерам/модераторам из
// таблицы managers: они видят рабочие уведомления (заявки, поддержка), но не обязаны
// знать о попытках входа в веб-панель /admin — это другой уровень доступа.
async function sendSecurityAlert(text) {
  const chatId = process.env.TELEGRAM_MODERATOR_CHAT_ID;
  if (!chatId) return;
  return sendToChat(chatId, text);
}

async function answerCallback(callbackQueryId, text) {
  if (!isEnabled()) return;
  await axios
    .post(apiUrl('answerCallbackQuery'), {
      callback_query_id: callbackQueryId,
      text,
    })
    .catch((err) => {
      console.error('Failed to answer callback query:', err.message);
    });
}

// === Исполнитель: привязка чата + доставка лидов в бот ===

async function sendToChat(chatId, text, replyMarkup) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] -> chat ${chatId}: ${text}`);
    return;
  }
  await axios
    .post(apiUrl('sendMessage'), {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
    .catch((err) => {
      console.error('Failed to send message to chat:', err.response ? JSON.stringify(err.response.data) : err.message);
    });
}

// Вопрос в поддержку от исполнителя → модератору. Шапка "💬 #<id> · имя · категория"
// — по ней бот находит мастера, когда модератор отвечает (native reply или кнопка).
// replyToMessageId связывает сообщения одного треда в цепочку. Возвращает message_id.
async function forwardSupportMessage(master, body, replyToMessageId) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] support Q from master ${master.id} (${master.name}): ${body}`);
    return null;
  }

  const cat = (await require('./category.service').get(master.category))?.name_ru || MASTER_CATEGORY_LABELS[master.category] || master.category || '';
  const bal = master.balance_tetri != null ? ` · ${(master.balance_tetri / 100).toFixed(2)} ₾` : '';
  const text = `💬 #${master.id} · ${master.name} · ${cat}${bal}\n━━━━━━━━━━\n${body}`;
  const markup = { inline_keyboard: [[{ text: '✍️ Ответить', callback_data: `support:${master.id}` }]] };

  let firstId = null;
  for (const chatId of await getModeratorChatIds()) {
    try {
      const { data } = await axios.post(apiUrl('sendMessage'), {
        chat_id: chatId,
        text,
        // цепочку тредим только у первого адресата (там же хранится last tg_message_id)
        ...(replyToMessageId && !firstId ? { reply_to_message_id: replyToMessageId } : {}),
        reply_markup: markup,
      });
      if (!firstId) firstId = data.result.message_id;
    } catch (err) {
      console.error(`forwardSupportMessage -> ${chatId}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
  return firstId;
}

// Лид в бот исполнителя. Возвращает true при успешной отправке — иначе caller
// (order.service notifyMasters) откатывается на SMS, чтобы заявка не потерялась.
//
// Номер клиента и WhatsApp-ссылка сюда сознательно НЕ попадают — единственная кнопка
// ведёт на /order/<token>?master=, ту же страницу, что открывает SMS-лид. Там уже есть
// вся защита от закрытой заявки (кнопки Call/WhatsApp скрываются по order.status в
// момент открытия страницы, не в момент отправки лида) и логирование звонка/WhatsApp/
// просмотра — доделывать её отдельно под Telegram не нужно, и нечему "утекать" в
// сообщении после того, как заказчик закроет заявку.
async function sendLeadToMaster(master, order, link) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] lead #${order.id} -> master ${master.id} via Telegram (chat ${master.telegram_id})`);
    return true;
  }

  const lines = [(order.is_technical ? '🧪 ТЕСТ · ' : '') + `🆕 Заявка #${order.id}`, '', order.description];
  if (order.district_name) lines.push('', `📍 ${order.district_name}`);
  lines.push('', 'Нажмите ниже, чтобы посмотреть детали и позвонить или написать в WhatsApp.');

  try {
    await axios.post(apiUrl('sendMessage'), {
      chat_id: master.telegram_id,
      text: lines.join('\n'),
      reply_markup: { inline_keyboard: [[{ text: '📄 Открыть заявку', url: link }]] },
    });
    return true;
  } catch (err) {
    console.error(
      `Failed to send lead #${order.id} to master ${master.id} on Telegram:`,
      err.response ? JSON.stringify(err.response.data) : err.message
    );
    return false;
  }
}

function formatDispatchLine(category, vehicleSize, masterCount) {
  let label = CATEGORY_LABELS[category] || category;
  if (vehicleSize) label += ` (${SIZE_LABELS[vehicleSize] || vehicleSize})`;
  return `➡️ ${label} — отправлено ${masterCount}`;
}

function buildMessageText(order, dispatchLines, funnel) {
  const header =
    order.status === 'closed'
      ? '🔒 Заявка закрыта'
      : order.status === 'needs_revision' ? '✏️ Ожидаем уточнения клиента: ' + order.revision_reason
      : dispatchLines.length
      ? '✅ Разослано'
      : '🆕 Новая заявка на модерацию';
  const lines = [
    (order.is_technical ? '🧪 ТЕСТ · ' : '') + header,
    '',
    moderatorDescription(order),
    '',
    `📍 ${order.district_name || '—'}`,
    `📞 ${order.phone}`,
  ];

  if (dispatchLines.length) {
    lines.push('', ...dispatchLines);
    lines.push(
      '',
      '📊 Воронка:',
      `👀 Перешли по ссылке: ${funnel.view}`,
      `📞 Нажали «Позвонить»: ${funnel.call}`,
      `💬 Нажали «WhatsApp»: ${funnel.whatsapp}`
    );
  }

  return lines.join('\n');
}

async function refreshMessage(order, keyboard) {
  if (!isEnabled()) return;

  let msgs = await orderService.getModerationMessages(order.id).catch(() => []);
  if (!msgs.length && order.moderation_message_id && process.env.TELEGRAM_MODERATOR_CHAT_ID) {
    msgs = [{ chat_id: String(process.env.TELEGRAM_MODERATOR_CHAT_ID), message_id: order.moderation_message_id }];
  }
  if (!msgs.length) {
    console.error(`No moderation messages recorded for order ${order.token}`);
    return;
  }

  const dispatches = await orderService.getOrderDispatches(order.id).catch(() => []);
  const labels = await require('./category.service').groups(true);
  const dispatchLines = dispatches.map(d => (labels[d.category] || d.category)+(d.vehicle_size ? ' '+d.vehicle_size : '')+' — '+d.master_count);
  const funnel = await orderService.getOrderFunnelStats(order.id);
  const text = buildMessageText(order, dispatchLines, funnel);

  for (const m of msgs) {
    await axios
      .post(apiUrl('editMessageText'), { chat_id: m.chat_id, message_id: m.message_id, text, reply_markup: keyboard })
      .catch((err) => {
        const data = err.response ? JSON.stringify(err.response.data) : err.message;
        if (!data.includes('not modified')) {
          console.error(`refreshMessage edit ${m.message_id}@${m.chat_id} (order ${order.token}):`, data);
        }
      });
  }
}

async function refreshCategories(order, chatId, messageId, page = 0) {
  if (!isEnabled()) return;
  const keyboard = ['pending_review','new'].includes(order.status) ? await buildKeyboardWithCounts(order.token, page) : { inline_keyboard: [] };
  try {
    await axios.post(apiUrl('editMessageReplyMarkup'),{chat_id:chatId,message_id:messageId,reply_markup:keyboard});
  } catch(error) { if(!String(error.response?.data?.description || '').includes('not modified')) throw error; }
}

async function updateMessage(order) {
  if (!isEnabled()) return;
  const keyboard = ['closed','needs_revision','unverified'].includes(order.status) ? { inline_keyboard: [] } : await buildKeyboardWithCounts(order.token);
  await refreshMessage(order, keyboard);
}

async function setWebhook() {
  if (!isEnabled()) return;

  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    console.error(
      'TELEGRAM_WEBHOOK_SECRET is not set — the webhook is being (re)registered WITHOUT secret_token verification. ' +
      'Anyone who finds the webhook URL can forge Telegram updates (fake balance top-ups, fake approvals). Set TELEGRAM_WEBHOOK_SECRET and redeploy.'
    );
  }

  const url = `${getBaseUrl()}/api/telegram/webhook`;
  await axios.post(apiUrl('setWebhook'), { url, secret_token: secretToken }).catch((err) => {
    console.error('Failed to register Telegram webhook:', err.response ? JSON.stringify(err.response.data) : err.message);
  });
}

module.exports = {
  isEnabled,
  buildKeyboardWithCounts,
  refreshCategories,
  notifyModerator,
  notifyModeratorNewMaster,
  confirmMasterApproved,
  sendTopupReceipt,
  sendMessageToModerator,
  sendSecurityAlert,
  askModerator,
  answerCallback,
  updateMessage,
  setWebhook,
  sendToChat,
  sendLeadToMaster,
  forwardSupportMessage,
  CONTACT_KEYBOARD,
};
