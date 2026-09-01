-- Xtender database schema

CREATE TABLE IF NOT EXISTS districts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS masters (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    telegram_id BIGINT UNIQUE,
    category VARCHAR(100),
    vehicle_type VARCHAR(255),
    vehicle_size VARCHAR(20),
    price_text VARCHAR(100),
    description TEXT,
    avatar_url TEXT,
    rating NUMERIC(3, 2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS master_districts (
    master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    PRIMARY KEY (master_id, district_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    district_id INTEGER REFERENCES districts(id) ON DELETE RESTRICT,
    district_name TEXT NOT NULL DEFAULT '',
    token UUID NOT NULL UNIQUE,
    description TEXT NOT NULL,
    target_categories TEXT[] NOT NULL DEFAULT '{}',
    phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending_review',
    moderation_message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_views (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    event_type VARCHAR(20) NOT NULL DEFAULT 'view',
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, master_id, event_type)
);

CREATE TABLE IF NOT EXISTS order_files (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_dispatches (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    vehicle_size VARCHAR(20) NOT NULL DEFAULT '',
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, category, vehicle_size)
);

CREATE INDEX IF NOT EXISTS idx_order_files_order_id ON order_files(order_id);
CREATE INDEX IF NOT EXISTS idx_order_dispatches_order_id ON order_dispatches(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_target_categories ON orders USING GIN (target_categories);
CREATE INDEX IF NOT EXISTS idx_orders_district_id ON orders(district_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token);
CREATE INDEX IF NOT EXISTS idx_order_views_order_id ON order_views(order_id);
CREATE INDEX IF NOT EXISTS idx_order_views_master_id ON order_views(master_id);

-- CREATE TABLE IF NOT EXISTS ничего не делает, если таблица уже существует — даже если
-- в реальной (уже задеплоенной) версии таблицы не хватает колонок, добавленных сюда позже.
-- Поэтому для каждой такой колонки нужен отдельный ALTER TABLE ADD COLUMN IF NOT EXISTS,
-- иначе на реальной проде эти колонки просто не появятся.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS moderation_message_id BIGINT;

ALTER TABLE order_views ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'view';
ALTER TABLE order_views DROP CONSTRAINT IF EXISTS order_views_order_id_master_id_key;
ALTER TABLE order_views DROP CONSTRAINT IF EXISTS order_views_order_id_master_id_event_type_key;
ALTER TABLE order_views ADD CONSTRAINT order_views_order_id_master_id_event_type_key
    UNIQUE (order_id, master_id, event_type);

-- === Подписка мастеров, тиры размера машин, бортовые, отслеживание рассылки/закрытия ===

ALTER TABLE masters ADD COLUMN IF NOT EXISTS vehicle_size VARCHAR(20);
ALTER TABLE masters ADD COLUMN IF NOT EXISTS is_subscribed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS subscription_until TIMESTAMPTZ;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS is_flatbed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE masters DROP CONSTRAINT IF EXISTS masters_flatbed_requires_transport;
ALTER TABLE masters ADD CONSTRAINT masters_flatbed_requires_transport
    CHECK (NOT is_flatbed OR category = 'transport');

-- Миграция small/medium/large -> L/XL/XXL (1:1, без потери данных)
UPDATE masters SET vehicle_size = CASE vehicle_size
    WHEN 'small' THEN 'L' WHEN 'medium' THEN 'XL' WHEN 'large' THEN 'XXL' ELSE vehicle_size END
    WHERE vehicle_size IN ('small', 'medium', 'large');
UPDATE order_dispatches SET vehicle_size = CASE vehicle_size
    WHEN 'small' THEN 'L' WHEN 'medium' THEN 'XL' WHEN 'large' THEN 'XXL' ELSE vehicle_size END
    WHERE vehicle_size IN ('small', 'medium', 'large');

ALTER TABLE masters DROP CONSTRAINT IF EXISTS masters_vehicle_size_check;
ALTER TABLE masters ADD CONSTRAINT masters_vehicle_size_check
    CHECK (vehicle_size IS NULL OR vehicle_size IN ('L', 'XL', 'XXL'));

-- NULL не считается равным NULL для UNIQUE — без этого повторный диспатч категорий без
-- конкретного размера (грузчики/мусор/бортовые/все машины) не защищён от дублей SMS.
-- '' используется как сентинел "без размера" вместо NULL.
UPDATE order_dispatches SET vehicle_size = '' WHERE vehicle_size IS NULL;
ALTER TABLE order_dispatches ALTER COLUMN vehicle_size SET DEFAULT '';
ALTER TABLE order_dispatches ALTER COLUMN vehicle_size SET NOT NULL;
ALTER TABLE order_dispatches DROP CONSTRAINT IF EXISTS order_dispatches_vehicle_size_check;
ALTER TABLE order_dispatches ADD CONSTRAINT order_dispatches_vehicle_size_check
    CHECK (vehicle_size IN ('', 'L', 'XL', 'XXL'));

-- Отдельный секретный токен владельца заявки: ссылка в SMS клиенту работает с любого
-- устройства/браузера без привязки к куке (в отличие от куки, mastera его никогда не видят,
-- поэтому им нельзя подделать доступ владельца, просто обрезав ?master= из своей ссылки).
-- Короткий (10 символов, base62) вместо UUID — чтобы SMS с кодом+ссылкой укладывалась
-- в один сегмент (70 символов при кириллице).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS owner_token VARCHAR(20);

-- Основной token заявки тоже укорочен той же техникой — SMS мастерам (ссылка без текста
-- заявки) укладывается в 70 символов только с коротким токеном.
ALTER TABLE orders ALTER COLUMN token TYPE VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_owner_token ON orders(owner_token);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS first_dispatched_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Баланс исполнителя в тетри (1 GEL = 100 тетри) — списывается за каждое SMS-уведомление
-- о заявке (см. COST_PER_NOTIFICATION_TETRI в order.service.js). Самостоятельная регистрация
-- через /join создаёт мастера с is_active = false — до подтверждения модератором в Telegram
-- он не виден в каталоге и не участвует в рассылке (обе выборки уже фильтруют по is_active).
ALTER TABLE masters ADD COLUMN IF NOT EXISTS balance_tetri INTEGER NOT NULL DEFAULT 0;

-- Личная ссылка исполнителя (/master/<token>) — посмотреть баланс, без пароля/логина,
-- по той же схеме, что owner_token у заявки клиента.
ALTER TABLE masters ADD COLUMN IF NOT EXISTS master_token VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_masters_master_token ON masters(master_token);

-- Фиксация момента согласия на получение SMS-уведомлений (чекбокс на /join) —
-- нужна как доказательство явного согласия, а не просто текст на странице.
ALTER TABLE masters ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Telegram как альтернативный канал доставки лидов. Исполнитель привязывает чат
-- через t.me/<bot>?start=<master_token> из кабинета либо отправив свой номер боту.
-- Привязан telegram_id → лид уходит в бот (бесплатно, с текстом заявки, кликабельно),
-- SMS остаётся откатом на случай сбоя отправки. telegram_id для приватного чата = chat_id.
-- (telegram_id с UNIQUE есть в CREATE TABLE выше и в проде с первой миграции —
-- ADD COLUMN IF NOT EXISTS тут просто на всякий случай; telegram_linked_at новая.)
ALTER TABLE masters ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;

-- === Админ-панель: бан мастеров, история баланса, отзывы (2026-08-28) ===

ALTER TABLE masters ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS banned_reason TEXT;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

-- Полная история изменений баланса. amount_tetri знаковый (+ пополнение/коррекция вверх,
-- - списание за лид/коррекция вниз). order_id заполнен только для lead_charge и одновременно
-- фиксирует, каким мастерам реально ушло уведомление по заявке — раньше это нигде не хранилось.
CREATE TABLE IF NOT EXISTS balance_transactions (
    id SERIAL PRIMARY KEY,
    master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    amount_tetri INTEGER NOT NULL,
    reason VARCHAR(30) NOT NULL CHECK (reason IN ('topup', 'lead_charge', 'admin_correction')),
    note TEXT,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_master_id ON balance_transactions(master_id);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_order_id ON balance_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_created_at ON balance_transactions(created_at);

-- Публичные отзывы клиентов. is_approved=false по умолчанию — висит в очереди модерации
-- (/admin/reviews), в каталоге на сайте учитываются только approved.
CREATE TABLE IF NOT EXISTS master_reviews (
    id SERIAL PRIMARY KEY,
    master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    is_approved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_id, master_id)
);
CREATE INDEX IF NOT EXISTS idx_master_reviews_master_id ON master_reviews(master_id);
CREATE INDEX IF NOT EXISTS idx_master_reviews_is_approved ON master_reviews(is_approved);
