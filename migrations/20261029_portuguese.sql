-- Brazilian Portuguese ("pt"). Content is stored per language inside jsonb,
-- so questions, categories, category groups, reactions and announcements only
-- get new keys (text_pt / answers_pt / correct_answer.pt / category_pt /
-- short_pt / pt) — filled in by scripts/translate. The one schema change is
-- letting push tokens register as "pt"; run it before the app build that
-- offers Portuguese ships.

ALTER TABLE public.push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_language_check;
ALTER TABLE public.push_tokens
  ADD CONSTRAINT push_tokens_language_check
  CHECK (language IN ('en', 'tr', 'es', 'pt'));
