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

function isEnabled() {
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

async function setWebhook(url) {
  if (!isEnabled()) return;
  await axios.post(apiUrl('setWebhook'), { url });
}

module.exports = {
  isEnabled,
  notifyModerator,
  answerCallback,
  updateMessage,
  setWebhook,
};
