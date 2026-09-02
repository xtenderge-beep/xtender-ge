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
