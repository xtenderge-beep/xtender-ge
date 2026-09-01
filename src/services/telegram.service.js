const axios = require('axios');
const orderService = require('./order.service');
const { getBaseUrl } = require('../config/url');

const API_BASE = 'https://api.telegram.org/bot';
const SIZE_LABELS = { L: 'L', XL: 'XL', XXL: 'XXL' };
const SIZE_SPECS = { L: '180×180×380', XL: '200×190×400', XXL: '200×200×500' };
const SIZE_ORDER = ['L', 'XL', 'XXL'];
const CATEGORY_LABELS = {
  transport: '🚚 Машины',
  movers: '💪 Грузчики',
  junk: '🧹 Вывоз мусора',
  flatbed: '🚛 Бортовые / стройматериалы',
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
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_MODERATOR_CHAT_ID);
}

function apiUrl(method) {
  return `${API_BASE}${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function buildKeyboardWithCounts(token) {
  const counts = await orderService.getMasterCountsByCategory();

  const total = (category) =>
    counts.filter((row) => row.category === category).reduce((sum, row) => sum + row.count, 0);

  const transportSizes = counts
    .filter((row) => row.category === 'transport' && row.vehicle_size)
    .sort((a, b) => SIZE_ORDER.indexOf(a.vehicle_size) - SIZE_ORDER.indexOf(b.vehicle_size));

  const moversCount = total('movers');
  const junkCount = total('junk');
  const transportCount = total('transport');
  const flatbedCount = total('flatbed');

  const rows = [
    [{ text: `🚚 Машины — все размеры (${transportCount})`, callback_data: `cat:${token}:transport` }],
    [
      { text: `🧹 Вывоз мусора (${junkCount})`, callback_data: `cat:${token}:junk` },
      { text: `🚛 Бортовые (${flatbedCount})`, callback_data: `cat:${token}:flatbed` },
    ],
    [{ text: `💪 Грузчики (${moversCount})`, callback_data: `cat:${token}:movers` }],
  ];

  if (transportSizes.length) {
    transportSizes.forEach((row) => {
      rows.push([
        {
          text: `🚚 ${row.vehicle_size} ${SIZE_SPECS[row.vehicle_size] || ''} (${row.count})`,
          callback_data: `cat:${token}:transport:${row.vehicle_size}`,
        },
      ]);
    });
  }

  return { inline_keyboard: rows };
}

async function notifyModerator(order) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] order ${order.token} pending moderation: ${order.description}`);
    return null;
  }

  const base = getBaseUrl();
  const text = [
    '🆕 Новая заявка на модерацию',
    '',
    order.description,
    '',
    `📍 ${order.district_name || '—'}`,
    `📞 ${order.phone}`,
    `🔗 ${base}/order/${order.token}`,
    '',
    'Можно нажимать несколько кнопок — каждая шлёт заявку своей категории.',
  ].join('\n');

  const { data } = await axios.post(apiUrl('sendMessage'), {
    chat_id: process.env.TELEGRAM_MODERATOR_CHAT_ID,
    text,
    reply_markup: await buildKeyboardWithCounts(order.token),
  });

  return data.result.message_id;
}

const MASTER_CATEGORY_LABELS = {
  movers: '💪 Грузчик / разнорабочий',
  transport: '🚚 Водитель',
  junk: '🧹 Вывоз мусора',
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
    `${MASTER_CATEGORY_LABELS[master.category] || master.category}`,
  ];
  if (master.vehicle_type) lines.push(`🚙 ${master.vehicle_type}${master.vehicle_size ? ' (' + master.vehicle_size + ')' : ''}`);
  if (master.description) lines.push(`📝 ${master.description}`);

  const { data } = await axios.post(apiUrl('sendMessage'), {
    chat_id: process.env.TELEGRAM_MODERATOR_CHAT_ID,
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `master_approve:${master.id}` }]],
    },
  });

  return data.result.message_id;
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
  const body = { chat_id: process.env.TELEGRAM_MODERATOR_CHAT_ID, caption };
  body[isImage ? 'photo' : 'document'] = fileUrl;

  await axios.post(apiUrl(method), body).catch((err) => {
    console.error(
      'Failed to send topup receipt to moderator:',
      err.response ? JSON.stringify(err.response.data) : err.message
    );
  });
}

async function sendMessageToModerator(text, replyMarkup = ADMIN_MENU_KEYBOARD) {
  if (!isEnabled()) return;
  await axios
    .post(apiUrl('sendMessage'), { chat_id: process.env.TELEGRAM_MODERATOR_CHAT_ID, text, reply_markup: replyMarkup })
    .catch((err) => {
      console.error('Failed to send message to moderator:', err.message);
    });
}

async function askModerator(text) {
  return sendMessageToModerator(text, FORCE_REPLY);
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

// Лид в бот исполнителя. Возвращает true при успешной отправке — иначе caller
// (order.service notifyMasters) откатывается на SMS, чтобы заявка не потерялась.
async function sendLeadToMaster(master, order, link) {
  if (!isEnabled()) {
    console.log(`[TELEGRAM DEV MODE] lead #${order.id} -> master ${master.id} via Telegram (chat ${master.telegram_id})`);
    return true;
  }

  const lines = [`🆕 Заявка #${order.id}`, '', order.description];
  if (order.district_name) lines.push('', `📍 ${order.district_name}`);

  try {
    await axios.post(apiUrl('sendMessage'), {
      chat_id: master.telegram_id,
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📞 Позвонить', callback_data: `lead:call:${order.token}:${master.id}` },
            { text: '💬 WhatsApp', callback_data: `lead:wa:${order.token}:${master.id}` },
          ],
          [{ text: '📄 Открыть заявку', url: link }],
        ],
      },
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

// После тапа «Позвонить»/«WhatsApp» в боте — раскрываем контакт клиента прямо в
// сообщении: номер (Telegram сам делает его кликабельным) + кнопка WhatsApp + ссылка
// на страницу лида с ?master= (там логируется просмотр и работает форма отзыва).
async function revealLeadContact(callback, order, masterId) {
  if (!isEnabled()) return;

  const chat = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const digits = String(order.phone).replace(/\D/g, '');
  const baseText = callback.message.text || `🆕 Заявка #${order.id}`;
  const text = baseText.includes('📞 ') ? baseText : `${baseText}\n\n📞 ${order.phone}`;
  const link = `${getBaseUrl()}/order/${order.token}?master=${masterId}`;

  await axios
    .post(apiUrl('editMessageText'), {
      chat_id: chat,
      message_id: messageId,
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Открыть WhatsApp', url: `https://wa.me/${digits}` }],
          [{ text: '📄 Открыть заявку', url: link }],
        ],
      },
    })
    .catch((err) => {
      // "message is not modified" (повторный тап) — не ошибка
      const data = err.response ? JSON.stringify(err.response.data) : err.message;
      if (!data.includes('not modified')) console.error('Failed to reveal lead contact:', data);
    });
}

function formatDispatchLine(category, vehicleSize, masterCount) {
  let label = CATEGORY_LABELS[category] || category;
  if (vehicleSize) label += ` (${SIZE_LABELS[vehicleSize] || vehicleSize})`;
  return `➡️ ${label} — отправлено ${masterCount}`;
}

function buildMessageText(order, dispatchLines, funnel) {
  const header =
    order.status === 'closed'
      ? '🔒 Заявка закрыта клиентом'
      : dispatchLines.length
      ? '✅ Разослано'
      : '🆕 Новая заявка на модерацию';
  const lines = [
    header,
    '',
    order.description,
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
  if (!order.moderation_message_id) {
    console.error(`Cannot update Telegram message for order ${order.token}: moderation_message_id is missing`);
    return;
  }

  const dispatches = await orderService.getOrderDispatches(order.id).catch(() => []);
  const dispatchLines = dispatches.map((d) => formatDispatchLine(d.category, d.vehicle_size, d.master_count));
  const funnel = await orderService.getOrderFunnelStats(order.id);

  await axios
    .post(apiUrl('editMessageText'), {
      chat_id: process.env.TELEGRAM_MODERATOR_CHAT_ID,
      message_id: order.moderation_message_id,
      text: buildMessageText(order, dispatchLines, funnel),
      reply_markup: keyboard,
    })
    .catch((err) => {
      console.error(
        `Failed to edit Telegram message ${order.moderation_message_id} for order ${order.token}:`,
        err.response ? JSON.stringify(err.response.data) : err.message
      );
    });
}

async function updateMessage(order) {
  if (!isEnabled() || !order.moderation_message_id) return;
  const keyboard = order.status === 'closed' ? { inline_keyboard: [] } : await buildKeyboardWithCounts(order.token);
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
  notifyModerator,
  notifyModeratorNewMaster,
  confirmMasterApproved,
  sendTopupReceipt,
  sendMessageToModerator,
  askModerator,
  answerCallback,
  updateMessage,
  setWebhook,
  sendToChat,
  sendLeadToMaster,
  revealLeadContact,
  CONTACT_KEYBOARD,
};
