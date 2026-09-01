const orderService = require('../services/order.service');
const otpService = require('../services/otp.service');
const telegramService = require('../services/telegram.service');
const masterService = require('../services/master.service');
const reviewService = require('../services/review.service');
const smsService = require('../services/sms.service');
const promoService = require('../services/promo.service');
const supportService = require('../services/support.service');
const managerService = require('../services/manager.service');
const redis = require('../config/redis');
const { clientStrings } = require('../config/i18n');
const { toE164 } = require('../config/phone');
const { getBaseUrl } = require('../config/url');

const TOPUP_REGEX = /^\/topup\s+(\+?\d{9,15})\s+([\d.]+)$/;
// /promo КОД 5 [100] [метка]  — код, сумма GEL, необяз. лимит, необяз. метка (агент/канал)
const PROMO_REGEX = /^\/promo\s+(\S+)\s+([\d.]+)(?:\s+(\d+))?(?:\s+(.+))?$/;
const INVITE_HELP =
  'Формат: /invite 5 Имя\n5 — бонус в GEL, «Имя» (необязательно) — кому ссылка (видно в дашборде).\nКод создастся сам, ссылка одноразовая.';
const REF_MAX_GEL = 20; // потолок бонуса, который менеджер ставит сам в /ref
const SUPPORT_HEADER_REGEX = /^💬 #(\d+) /;
const ADMIN_FLOW_TTL_SECONDS = 300;

const PHONE_REGEX = /^\+?\d{9,15}$/;
// В синхроне с order.service COST_PER_NOTIFICATION_TETRI.
const LEAD_PRICE_TETRI = 30;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_CATEGORIES = new Set(['transport', 'movers', 'junk', 'flatbed']);
const ALLOWED_SIZES = new Set(['L', 'XL', 'XXL']);
const MY_ORDERS_COOKIE = 'my_orders';
const MY_ORDERS_MAX = 20;

function ownerCookieName(token) {
  return `order_${token}`;
}

function readMyOrderTokens(req) {
  try {
    const raw = req.cookies[MY_ORDERS_COOKIE];
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberOrderToken(req, res, token) {
  const tokens = [token, ...readMyOrderTokens(req).filter((t) => t !== token)].slice(0, MY_ORDERS_MAX);
  res.cookie(MY_ORDERS_COOKIE, JSON.stringify(tokens), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

async function create(req, res) {
  const { token } = req.body;
  const phone = (req.body.phone || '').replace(/\s+/g, '');

  if (!phone || !PHONE_REGEX.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: 'Order token is required' });
  }

  const verified = await otpService.isPhoneVerified(phone);
  if (!verified) {
    return res.status(400).json({ success: false, message: 'Phone not verified' });
  }

  const order = await orderService.activateOrder(token, phone);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  await otpService.clearVerified(phone);
  await orderService.attachFiles(order.id, req.files);

  res.cookie(ownerCookieName(order.token), '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
  rememberOrderToken(req, res, order.token);

  telegramService
    .notifyModerator(order)
    .then((messageId) => {
      if (messageId) return orderService.setModerationMessageId(order.id, messageId);
    })
    .catch((err) => {
      console.error('Failed to notify moderator:', err.message);
    });

  return res.json({ success: true, token: order.token, id: order.id });
}

function adminFlowKey(chatId) {
  return `admin_flow:${chatId}`;
}

async function getAdminFlow(chatId) {
  const raw = await redis.get(adminFlowKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function setAdminFlow(chatId, state) {
  await redis.set(adminFlowKey(chatId), JSON.stringify(state), 'EX', ADMIN_FLOW_TTL_SECONDS);
}

async function clearAdminFlow(chatId) {
  await redis.del(adminFlowKey(chatId));
}

async function applyTopUp(phone, amountGel) {
  const amountTetri = Math.round(amountGel * 100);
  const master = await masterService.topUpBalance(phone, amountTetri);
  if (!master) {
    await telegramService.sendMessageToModerator(`Исполнитель с номером ${phone} не найден`);
    return;
  }
  await telegramService.sendMessageToModerator(
    `💰 Баланс пополнен: ${master.name} (${master.phone}) +${amountGel} GEL → баланс ${(master.balance_tetri / 100).toFixed(2)} GEL`
  );
}

function formatMasterInfo(master) {
  const status = master.is_active ? '✅ активен' : '⏳ на модерации';
  return [
    `👤 ${master.name} (${master.phone})`,
    `Категория: ${master.category}${master.vehicle_type ? ' — ' + master.vehicle_type : ''}`,
    `Статус: ${status}`,
    `Баланс: ${(master.balance_tetri / 100).toFixed(2)} GEL`,
  ].join('\n');
}

// Ответ модератора исполнителю в поддержку из бота — native-reply или кнопка «Ответить».
async function deliverSupportReply(chatId, masterId, body) {
  const master = await supportService.postModeratorReply(masterId, body);
  await telegramService.sendToChat(
    chatId,
    master ? `✅ Ответ отправлен: ${master.name} (#${masterId})` : `Исполнитель #${masterId} не найден`
  );
}

async function handleAdminFlowStep(chatId, flow, rawText) {
  if (flow.action === 'support_reply') {
    await clearAdminFlow(chatId);
    await deliverSupportReply(chatId, flow.masterId, rawText);
    return;
  }

  if (flow.step === 'phone') {
    const phoneDigits = rawText.replace(/\s+/g, '');
    if (!PHONE_REGEX.test(phoneDigits)) {
      await telegramService.askModerator(chatId, 'Это не похоже на номер телефона. Введите номер телефона исполнителя:');
      return;
    }
    const phone = toE164(phoneDigits);

    if (flow.action === 'balance') {
      await clearAdminFlow(chatId);
      const master = await masterService.getMasterByPhone(phone);
      await telegramService.sendToChat(chatId, master ? formatMasterInfo(master) : `Исполнитель с номером ${phone} не найден`);
      return;
    }

    await setAdminFlow(chatId, { action: 'topup', step: 'amount', phone });
    await telegramService.askModerator(chatId, 'Введите сумму пополнения в GEL (например 10):');
    return;
  }

  if (flow.step === 'amount') {
    const amountGel = parseFloat(rawText.replace(',', '.'));
    if (!Number.isFinite(amountGel) || amountGel <= 0) {
      await telegramService.askModerator(chatId, 'Некорректная сумма. Введите сумму пополнения в GEL:');
      return;
    }
    await clearAdminFlow(chatId);
    await applyTopUp(flow.phone, amountGel);
  }
}

async function handleModeratorMessage(message) {
  // Доступ уже проверен в telegramWebhook (env-модератор или менеджер с is_moderator).
  const chatId = String((message.chat || {}).id);
  const text = (message.text || '').trim();

  // Native-reply на вопрос в поддержку («💬 #<id> …») — самый естественный жест.
  const repliedText = message.reply_to_message && message.reply_to_message.text;
  const supportMatch = repliedText && repliedText.match(SUPPORT_HEADER_REGEX);
  if (supportMatch && text) {
    await clearAdminFlow(chatId);
    await deliverSupportReply(chatId, parseInt(supportMatch[1], 10), text);
    return;
  }

  if (text === '/start' || text === '/menu') {
    await clearAdminFlow(chatId);
    await telegramService.sendToChat(
      chatId,
      'Меню модератора 👇\n\n' +
        '/invite 5 Имя — ссылка для регистрации с бонусом\n' +
        '/promo КОД 5 100 — код-кампания\n' +
        '/support — открытые вопросы\n' +
        '/topup +995… 10 — пополнить баланс\n' +
        '/id — узнать ID чата\n\n' +
        '(/ref и /mystats — для менеджеров: заведите себя в /admin/managers)'
    );
    return;
  }

  // /ref и /mystats долетают сюда только от env-модератора (у менеджера их
  // перехватывает webhook раньше). Подсказываем правильную команду.
  if (text === '/mystats' || text === '/ref' || text.startsWith('/ref ')) {
    await telegramService.sendToChat(chatId, 'Это команды менеджера. Ваша ссылка без привязки: /invite 5 Имя');
    return;
  }

  if (text === '/support') {
    await clearAdminFlow(chatId);
    const open = await supportService.openThreads();
    if (!open.length) {
      await telegramService.sendToChat(chatId, 'Открытых вопросов нет ✅');
      return;
    }
    const lines = open.map((t) => {
      const mins = Math.round((Date.now() - new Date(t.created_at).getTime()) / 60000);
      const ago = mins < 60 ? `${mins} мин` : `${Math.round(mins / 60)} ч`;
      return `#${t.master_id} ${t.name} — ${ago} назад:\n«${(t.body || '').slice(0, 80)}»`;
    });
    await telegramService.sendToChat(chatId, `Открытые вопросы (${open.length}):\n\n${lines.join('\n\n')}`);
    return;
  }

  const promoMatch = PROMO_REGEX.exec(text);
  if (promoMatch) {
    await clearAdminFlow(chatId);
    const code = promoMatch[1].toUpperCase();
    const amountGel = parseFloat(promoMatch[2].replace(',', '.'));
    const maxRedemptions = promoMatch[3] ? parseInt(promoMatch[3], 10) : null;
    const label = (promoMatch[4] || '').trim().slice(0, 120) || null;
    if (!Number.isFinite(amountGel) || amountGel <= 0) {
      await telegramService.sendToChat(chatId, 'Некорректная сумма. Пример: /promo START5 5 100 Агент Гиорги');
      return;
    }
    const saved = await promoService.createCode({
      code,
      amountTetri: Math.round(amountGel * 100),
      maxRedemptions,
      label,
    });
    await telegramService.sendToChat(chatId,
      `🎟 Промокод ${saved.code}: ${(saved.amount_tetri / 100).toFixed(2)} GEL за регистрацию` +
        `${saved.max_redemptions ? `, лимит ${saved.max_redemptions}` : ', без лимита'}` +
        `${saved.label ? `\nМетка: ${saved.label}` : ''}` +
        `\nСсылка: ${getBaseUrl()}/join?promo=${saved.code}`
    );
    return;
  }

  if (text === '/invite' || text.startsWith('/invite ')) {
    await clearAdminFlow(chatId);
    const rest = text.slice('/invite'.length).trim();
    const m = rest.match(/^([\d.,]+)(?:\s+(.+))?$/);
    const amountGel = m ? parseFloat(m[1].replace(',', '.')) : NaN;
    if (!Number.isFinite(amountGel) || amountGel <= 0) {
      await telegramService.sendToChat(chatId, INVITE_HELP);
      return;
    }
    const label = (m[2] || '').trim().slice(0, 120) || null;
    const saved = await promoService.createCode({
      code: await promoService.generateCode(),
      amountTetri: Math.round(amountGel * 100),
      maxRedemptions: 1,
      label,
    });
    await telegramService.sendToChat(chatId,
      `🎟 Ссылка для регистрации${saved.label ? ` — ${saved.label}` : ''}:\n` +
        `${getBaseUrl()}/join?promo=${saved.code}\n\n` +
        `+${amountGel.toFixed(2)} GEL на баланс, одноразовая.`
    );
    return;
  }

  if (text === '/promo') {
    await clearAdminFlow(chatId);
    const codes = (await promoService.listCodes()).filter((c) => c.is_active);
    if (!codes.length) {
      await telegramService.sendToChat(chatId, 'Активных промокодов нет.\nЛичная ссылка: /invite 5 Имя\nКампания: /promo КОД 5 100');
      return;
    }
    const lines = codes.map((c) => {
      const limit = c.max_redemptions ? `${c.redeemed_count}/${c.max_redemptions}` : `${c.redeemed_count}/∞`;
      return `${c.code} — ${(c.amount_tetri / 100).toFixed(2)} GEL · использован ${limit}`;
    });
    await telegramService.sendToChat(chatId, `Промокоды:\n\n${lines.join('\n')}`);
    return;
  }

  if (text === '💰 Пополнить баланс') {
    await setAdminFlow(chatId, { action: 'topup', step: 'phone' });
    await telegramService.askModerator(chatId, 'Введите номер телефона исполнителя:');
    return;
  }

  if (text === '🔍 Проверить баланс') {
    await setAdminFlow(chatId, { action: 'balance', step: 'phone' });
    await telegramService.askModerator(chatId, 'Введите номер телефона исполнителя:');
    return;
  }

  const flow = await getAdminFlow(chatId);
  if (flow) {
    await handleAdminFlowStep(chatId, flow, text);
    return;
  }

  const match = TOPUP_REGEX.exec(text);
  if (match) {
    await applyTopUp(toE164(match[1]), parseFloat(match[2]));
  }
}

async function handleMasterApproval(callback) {
  const masterId = parseInt(callback.data.split(':')[1], 10);
  const master = await masterService.approveMaster(masterId);

  if (!master) {
    await telegramService.answerCallback(callback.id, 'Исполнитель не найден');
    return;
  }

  await telegramService.answerCallback(callback.id, 'Одобрено');
  await telegramService.confirmMasterApproved(callback.message.chat.id, callback.message.message_id, master);
}

// === Исполнитель в боте: привязка Telegram-чата + кнопки на лиде ===

const TG_LINK_PROMPT =
  'Отправьте свой номер телефона кнопкой ниже — найду ваш профиль исполнителя и подключу уведомления о заявках сюда.';
const TG_LINK_OK = (name) => `✅ Готово${name ? ', ' + name : ''}! Новые заявки будут приходить сюда, в Telegram.`;

async function handleMasterStart(message) {
  const payload = (message.text || '').trim().split(/\s+/)[1];
  if (payload) {
    const master = await masterService.linkTelegram({ masterToken: payload, telegramId: message.from.id });
    if (master) {
      await telegramService.sendToChat(message.chat.id, TG_LINK_OK(master.name), { remove_keyboard: true });
      return;
    }
  }
  await telegramService.sendToChat(message.chat.id, TG_LINK_PROMPT, telegramService.CONTACT_KEYBOARD);
}

async function handleContactShared(message) {
  const contact = message.contact || {};
  // request_contact гарантирует, что это собственный номер отправителя (user_id === from.id);
  // пересланный чужой контакт отсекаем.
  if (!contact.phone_number || contact.user_id !== message.from.id) {
    await telegramService.sendToChat(message.chat.id, 'Пришлите свой номер кнопкой «📱 Отправить номер».');
    return;
  }
  const phone = toE164(contact.phone_number);

  // Сначала — менеджер (админ завёл по этому номеру в /admin/managers).
  const manager = await managerService.getByPhone(phone);
  if (manager) {
    const linked = await managerService.linkTelegram(manager.id, message.from.id);
    const lines = [`✅ Готово, ${linked.name}! Вы менеджер xtender.`, ''];
    lines.push('/ref 5 Имя — ссылка для регистрации исполнителя (бонус 5 GEL)', '/mystats — сколько вы привели');
    if (linked.is_moderator) lines.push('', 'Вы также модератор — заявки на модерацию будут приходить сюда.');
    await telegramService.sendToChat(message.chat.id, lines.join('\n'), { remove_keyboard: true });
    return;
  }

  // Иначе — исполнитель.
  const master = await masterService.linkTelegram({ phone, telegramId: message.from.id });
  if (master) {
    await telegramService.sendToChat(message.chat.id, TG_LINK_OK(master.name), { remove_keyboard: true });
  } else {
    await telegramService.sendToChat(
      message.chat.id,
      `На этот номер не зарегистрирован профиль исполнителя. Регистрация: ${getBaseUrl()}/join`,
      { remove_keyboard: true }
    );
  }
}

// Команды менеджера (в т.ч. модератора): /ref, /mystats.
async function handleManagerCommand(message, manager) {
  const chatId = String(message.chat.id);
  const text = (message.text || '').trim();

  if (text === '/mystats') {
    const s = await managerService.getStats(manager.id);
    await telegramService.sendToChat(
      chatId,
      `Ваши исполнители: ${s.total}\nАктивных: ${s.active}\nВыдано бонусов: ${(s.bonusPaidTetri / 100).toFixed(2)} ₾`
    );
    return;
  }

  if (text === '/ref' || text.startsWith('/ref ')) {
    const rest = text.slice('/ref'.length).trim();
    const m = rest.match(/^([\d.,]+)(?:\s+(.+))?$/);
    const amountGel = m ? parseFloat(m[1].replace(',', '.')) : NaN;
    if (!Number.isFinite(amountGel) || amountGel <= 0 || amountGel > REF_MAX_GEL) {
      await telegramService.sendToChat(
        chatId,
        `Формат: /ref 5 Имя\nСумма 1–${REF_MAX_GEL} GEL, «Имя» (необязательно) — кому ссылка.`
      );
      return;
    }
    const label = (m[2] || '').trim().slice(0, 120) || null;
    const saved = await promoService.createCode({
      code: await promoService.generateCode(),
      amountTetri: Math.round(amountGel * 100),
      maxRedemptions: 1,
      managerId: manager.id,
      label: label || manager.name,
    });
    await telegramService.sendToChat(
      chatId,
      `🎟 Ссылка для регистрации${label ? ` — ${label}` : ''}:\n${getBaseUrl()}/join?promo=${saved.code}\n\n` +
        `+${amountGel.toFixed(2)} GEL на баланс, одноразовая.`
    );
    return;
  }

  await telegramService.sendToChat(chatId, `${manager.name}, команды: /ref 5 Имя · /mystats`);
}

// Обычный текст боту от привязанного исполнителя — это вопрос в поддержку.
async function handleMasterText(message) {
  const master = await masterService.getMasterByTelegramId(message.from.id);
  if (!master) return; // незнакомый чат — молчим
  const body = message.text.trim().slice(0, 2000);
  if (!body) return;
  await supportService.forwardQuestion(master, body);
  await telegramService.sendToChat(message.chat.id, '✅ Вопрос отправлен модератору. Ответ придёт сюда и в кабинет.');
}

async function handleSupportReplyCallback(callback) {
  const chatId = String(callback.message.chat.id);
  const fromId = (callback.from || {}).id;
  const allowed =
    chatId === String(process.env.TELEGRAM_MODERATOR_CHAT_ID) || (await managerService.isActiveModerator(fromId));
  if (!allowed) {
    await telegramService.answerCallback(callback.id, '');
    return;
  }
  const masterId = parseInt(callback.data.split(':')[1], 10);
  const master = await masterService.getMasterById(masterId);
  await telegramService.answerCallback(callback.id, 'Введите ответ');
  await setAdminFlow(chatId, { action: 'support_reply', masterId });
  await telegramService.askModerator(chatId, `Ответ для ${master ? master.name : 'исполнителя'} (#${masterId}):`);
}

async function telegramWebhook(req, res) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    return res.sendStatus(401);
  }

  try {
    const update = req.body;

    if (update.message) {
      const message = update.message;
      const text = (message.text || '').trim();
      const fromId = (message.from || {}).id;

      // /id — работает в любом чате (узнать свой ID / ID группы).
      if (text === '/id') {
        await telegramService.sendToChat(message.chat.id, `Ваш ID: ${fromId}\nЭтот чат: ${(message.chat || {}).id}`);
        return res.sendStatus(200);
      }

      const isEnvModerator = String((message.chat || {}).id) === String(process.env.TELEGRAM_MODERATOR_CHAT_ID);
      const manager = fromId ? await managerService.getByTelegramId(fromId) : null;
      const isModerator = isEnvModerator || (manager && manager.is_moderator && manager.is_active);
      const isManagerCmd = manager && manager.is_active && (text === '/mystats' || text === '/ref' || text.startsWith('/ref '));

      if (message.contact) {
        await handleContactShared(message);
      } else if (isManagerCmd) {
        await handleManagerCommand(message, manager);
      } else if (isModerator && text) {
        await handleModeratorMessage(message);
      } else if (manager && manager.is_active && text) {
        await handleManagerCommand(message, manager);
      } else if (text.startsWith('/start')) {
        await handleMasterStart(message);
      } else if (text) {
        await handleMasterText(message);
      }
      return res.sendStatus(200);
    }

    const callback = update.callback_query;
    if (!callback || !callback.data) {
      return res.sendStatus(200);
    }

    if (callback.data.startsWith('support:')) {
      await handleSupportReplyCallback(callback);
      return res.sendStatus(200);
    }

    if (callback.data.startsWith('master_approve:')) {
      await handleMasterApproval(callback);
      return res.sendStatus(200);
    }

    if (!callback.data.startsWith('cat:')) {
      return res.sendStatus(200);
    }

    const [, token, categoryRaw, sizeRaw] = callback.data.split(':');
    const category = ALLOWED_CATEGORIES.has(categoryRaw) ? categoryRaw : null;
    const vehicleSize = sizeRaw && ALLOWED_SIZES.has(sizeRaw) ? sizeRaw : null;

    if (!category) {
      await telegramService.answerCallback(callback.id, 'Некорректная категория');
      return res.sendStatus(200);
    }

    const order = await orderService.getOrderByToken(token);
    if (!order || order.status === 'closed') {
      await telegramService.answerCallback(callback.id, 'Заявка закрыта или не найдена');
      return res.sendStatus(200);
    }

    const isNewDispatch = await orderService.recordDispatch(order.id, category, vehicleSize);
    if (!isNewDispatch) {
      await telegramService.answerCallback(callback.id, 'Уже отправлено этой категории');
      return res.sendStatus(200);
    }

    await orderService.markFirstDispatch(token);

    const updatedOrder = await orderService.addTargetCategories(token, [category]);
    await telegramService.answerCallback(callback.id, 'Разослано исполнителям');

    const masterCount = await orderService.notifyMasters(updatedOrder, category, vehicleSize);
    console.log(`Dispatched order ${token} to ${masterCount} masters (${category}${vehicleSize ? ':' + vehicleSize : ''})`);

    telegramService.updateMessage(updatedOrder).catch((err) => {
      console.error('Failed to update Telegram message:', err.message);
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook handler failed:', err.message);
    return res.sendStatus(200);
  }
}

async function show(req, res) {
  const { token } = req.params;
  const order = await orderService.getOrderByToken(token);

  if (!order) {
    return res.status(404).render('order', {
      order: null,
      files: [],
      isOwner: false,
      masterId: null,
      funnel: null,
      masterAccount: null,
      clientStrings: clientStrings(req.lang),
    });
  }

  const isOwner = req.cookies[ownerCookieName(token)] === '1';
  const masterId = req.query.master || null;
  const files = await orderService.getOrderFiles(order.id);
  const funnel = isOwner ? await orderService.getOrderFunnelStats(order.id) : null;

  // Плашка «баланс · мой аккаунт» + предупреждение о низком балансе — только для мастера,
  // открывшего лид по своей ссылке (?master=<id>), не для владельца заявки.
  let masterAccount = null;
  if (masterId && !isOwner) {
    const m = await masterService.getMasterById(Number(masterId));
    if (m && !m.is_banned) {
      masterAccount = {
        token: m.master_token,
        balanceTetri: m.balance_tetri,
        leadsLeft: Math.floor(m.balance_tetri / LEAD_PRICE_TETRI),
      };
    }
  }

  return res.render('order', {
    order,
    files,
    isOwner,
    masterId,
    funnel,
    masterAccount,
    clientStrings: clientStrings(req.lang),
  });
}

async function showByOwnerToken(req, res) {
  const { ownerToken } = req.params;
  const order = await orderService.getOrderByOwnerToken(ownerToken);

  if (!order) {
    return res.status(404).render('order', {
      order: null,
      files: [],
      isOwner: false,
      masterId: null,
      funnel: null,
      masterAccount: null,
      clientStrings: clientStrings(req.lang),
    });
  }

  res.cookie(ownerCookieName(order.token), '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
  rememberOrderToken(req, res, order.token);

  const files = await orderService.getOrderFiles(order.id);
  const funnel = await orderService.getOrderFunnelStats(order.id);

  return res.render('order', {
    order,
    files,
    isOwner: true,
    masterId: null,
    funnel,
    masterAccount: null,
    clientStrings: clientStrings(req.lang),
  });
}

async function myOrders(req, res) {
  const tokens = readMyOrderTokens(req);
  const orders = await orderService.getOrdersByTokens(tokens);
  return res.render('my-orders', {
    orders,
    clientStrings: clientStrings(req.lang),
  });
}

async function close(req, res) {
  const { token } = req.params;
  const isOwner = req.cookies[ownerCookieName(token)] === '1';

  if (!isOwner) {
    return res.status(403).json({ success: false, message: 'Not allowed' });
  }

  const order = await orderService.closeOrder(token);

  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  telegramService.updateMessage(order).catch((err) => {
    console.error('Failed to update Telegram message on close:', err.message);
  });

  reviewService.getEligibleMasters(order.id).then((masters) => {
    if (!masters.length) return null;
    const link = `${getBaseUrl()}/review/${order.owner_token}`;
    return smsService.sendOrderNotification(order.phone, `Xtender: order #${order.id} closed. Rate the provider: ${link}`);
  }).catch((err) => {
    console.error('Failed to send review invite SMS:', err.message);
  });

  return res.json({ success: true, message: 'Order closed' });
}

const ALLOWED_EVENT_TYPES = new Set(['view', 'call', 'whatsapp']);

async function logView(req, res) {
  const { token } = req.params;
  const { masterId, eventType } = req.body;

  if (!masterId) {
    return res.status(400).json({ success: false, message: 'masterId is required' });
  }

  const order = await orderService.getOrderByToken(token);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  const type = ALLOWED_EVENT_TYPES.has(eventType) ? eventType : 'view';
  await orderService.logView(order.id, masterId, type);
  telegramService.updateMessage(order).catch(() => {});

  return res.json({ success: true });
}

module.exports = {
  create,
  show,
  showByOwnerToken,
  close,
  logView,
  telegramWebhook,
  myOrders,
};
