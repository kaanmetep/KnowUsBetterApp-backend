-- Tokens registered before this column existed default to English until the
-- app re-registers them with the user's language on its next launch.
ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'tr', 'es'));

CREATE INDEX IF NOT EXISTS idx_push_tokens_active_language
  ON push_tokens(platform, is_active, language);
