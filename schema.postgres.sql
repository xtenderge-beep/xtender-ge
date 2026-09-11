-- Миграции только для реального Postgres — накатываются в runMigrations() (app.js)
-- ПОСЛЕ schema.sql. dev-server.js их не применяет (SKIP_DB_MIGRATIONS=1): pg-mem не
-- поддерживает plpgsql-функции и триггеры, а на in-memory базе они и не нужны.
--
-- Всё здесь должно быть идемпотентным (файл прогоняется при каждом старте).

-- sms_consent_logs строго append-only: UPDATE и DELETE запрещены на уровне БД, чтобы
-- юридическое доказательство согласия нельзя было переписать даже с полным доступом
-- к приложению и его роли в базе.
CREATE OR REPLACE FUNCTION sms_consent_logs_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'sms_consent_logs is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sms_consent_logs_append_only ON sms_consent_logs;
CREATE TRIGGER trg_sms_consent_logs_append_only
    BEFORE UPDATE OR DELETE ON sms_consent_logs
    FOR EACH ROW EXECUTE PROCEDURE sms_consent_logs_block_mutation();

DROP TRIGGER IF EXISTS trg_sms_consent_logs_no_truncate ON sms_consent_logs;
CREATE TRIGGER trg_sms_consent_logs_no_truncate
    BEFORE TRUNCATE ON sms_consent_logs
    FOR EACH STATEMENT EXECUTE PROCEDURE sms_consent_logs_block_mutation();

-- Persistent receipt review, independent of balance crediting (Telegram/admin).
CREATE TABLE IF NOT EXISTS topup_receipts (
 id SERIAL PRIMARY KEY,
 master_id INTEGER NOT NULL REFERENCES masters(id),
 filename TEXT NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','credited','rejected')),
 balance_transaction_id INTEGER UNIQUE REFERENCES balance_transactions(id),
 credited_tetri INTEGER,
 note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ,
 CHECK ((status = 'credited' AND balance_transaction_id IS NOT NULL AND credited_tetri > 0) OR (status <> 'credited' AND balance_transaction_id IS NULL AND credited_tetri IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_topup_receipts_master ON topup_receipts(master_id, created_at);
