-- French ("fr"), Japanese ("ja") and Dutch ("nl"). Content is stored per
-- language inside jsonb (filled by scripts/translate), so the one schema change
-- is letting push tokens register in the new languages. Without it the insert in
-- pushTokenService fails the CHECK and fr/ja/nl devices get no pushes.
-- Run it before the app build that offers these languages ships.

ALTER TABLE public.push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_language_check;
ALTER TABLE public.push_tokens
  ADD CONSTRAINT push_tokens_language_check
  CHECK (language IN ('en', 'tr', 'es', 'pt', 'de', 'it', 'pl', 'fr', 'ja', 'nl'));
