-- Daily Analysis: once every 24 hours a couple plays a short game on a topic
-- and gets a detailed AI report about the two of them, kept in an archive.
-- Replaces the paid end-of-game "AI analysis" (whose endpoints stay up for
-- older app builds).
--
-- - The listed category 'daily_analysis' is what the app starts the game
--   with. Its coins_required is the price, paid by the host at game start
--   and refunded if the game doesn't finish.
-- - The topics are the other categories of the 'daily_analysis' group. They
--   are unlisted (is_listed = false): the app never shows them, the server
--   picks one per analysis (the topic the host has done the fewest times, by
--   order_index) and plays DAILY_ANALYSIS_QUESTION_COUNT (8) of its questions.
--   Add questions to them from the admin panel like any category. New topics
--   can be added the same way; renaming or removing one is safe.
-- - Questions play like "See Your Match": both players answer for
--   themselves. Choice questions (have_answers true, no correct_answer) and a
--   few text questions per topic work best.
--
-- Deploy the backend that knows "daily_analysis" BEFORE running this. Only
-- app builds that send the "daily_analysis" client feature list or start it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.daily_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_app_user_id text NOT NULL,
  -- Everyone who played; each of them can't start another for 24 hours.
  participant_ids text[] NOT NULL,
  topic_id text NOT NULL,
  chapter integer NOT NULL,
  language text NOT NULL DEFAULT 'en',
  -- playing -> analyzing -> ready | failed. A game that doesn't finish
  -- deletes its "playing" row.
  status text NOT NULL DEFAULT 'playing'
    CHECK (status IN ('playing', 'analyzing', 'ready', 'failed')),
  players jsonb NOT NULL DEFAULT '[]'::jsonb,
  rounds jsonb,
  percentage integer,
  report jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ready_at timestamptz
);

CREATE INDEX IF NOT EXISTS daily_analyses_participants_idx
  ON public.daily_analyses USING gin (participant_ids);
CREATE INDEX IF NOT EXISTS daily_analyses_started_at_idx
  ON public.daily_analyses (started_at DESC);

-- Only the backend (service role) reads and writes it.
ALTER TABLE public.daily_analyses ENABLE ROW LEVEL SECURITY;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'daily_analysis',
  '{"category_en": "Daily Analysis", "category_tr": "Günlük Analiz", "category_es": "Análisis Diario", "category_pt": "Análise Diária"}'::jsonb,
  0,
  'sparkles',
  'Ionicons'
)
ON CONFLICT (id) DO UPDATE SET
  labels = EXCLUDED.labels,
  order_index = EXCLUDED.order_index,
  icon_name = EXCLUDED.icon_name,
  icon_type = EXCLUDED.icon_type;

INSERT INTO public.categories (
  id, labels, group_id, color, icon_name, icon_type,
  coins_required, is_premium, recently_added, difficulty, order_index, is_listed
) VALUES
(
  'daily_analysis',
  '{"category_en": "Daily Analysis", "category_tr": "Günlük Analiz", "category_es": "Análisis Diario", "category_pt": "Análise Diária", "short_en": "Analysis", "short_tr": "Analiz", "short_es": "Análisis", "short_pt": "Análise"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'sparkles', 'Ionicons',
  5, false, true, NULL, 0, true
),
(
  'daily_love_language',
  '{"category_en": "How You Show Love", "category_tr": "Sevgiyi Gösterme Biçiminiz", "category_es": "Cómo Demuestran el Amor", "category_pt": "Como Vocês Demonstram Amor", "short_en": "Love", "short_tr": "Sevgi", "short_es": "Amor", "short_pt": "Amor"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'heart', 'Ionicons',
  0, false, false, NULL, 1, false
),
(
  'daily_conflict',
  '{"category_en": "When You Disagree", "category_tr": "Anlaşamadığınızda", "category_es": "Cuando No Están de Acuerdo", "category_pt": "Quando Vocês Discordam", "short_en": "Conflict", "short_tr": "Tartışma", "short_es": "Conflicto", "short_pt": "Conflito"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'flash', 'Ionicons',
  0, false, false, NULL, 2, false
),
(
  'daily_everyday_life',
  '{"category_en": "Your Everyday Life", "category_tr": "Gündelik Hayatınız", "category_es": "Su Día a Día", "category_pt": "O Dia a Dia de Vocês", "short_en": "Everyday", "short_tr": "Gündelik", "short_es": "Día a día", "short_pt": "Dia a dia"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'sunny', 'Ionicons',
  0, false, false, NULL, 3, false
),
(
  'daily_trust_jealousy',
  '{"category_en": "Trust & Jealousy", "category_tr": "Güven ve Kıskançlık", "category_es": "Confianza y Celos", "category_pt": "Confiança e Ciúme", "short_en": "Trust", "short_tr": "Güven", "short_es": "Confianza", "short_pt": "Confiança"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'lock-closed', 'Ionicons',
  0, false, false, NULL, 4, false
),
(
  'daily_future',
  '{"category_en": "Your Future", "category_tr": "Geleceğiniz", "category_es": "Su Futuro", "category_pt": "O Futuro de Vocês", "short_en": "Future", "short_tr": "Gelecek", "short_es": "Futuro", "short_pt": "Futuro"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'telescope', 'Ionicons',
  0, false, false, NULL, 5, false
),
(
  'daily_money',
  '{"category_en": "Money & Spending", "category_tr": "Para ve Harcama", "category_es": "Dinero y Gastos", "category_pt": "Dinheiro e Gastos", "short_en": "Money", "short_tr": "Para", "short_es": "Dinero", "short_pt": "Dinheiro"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'wallet', 'Ionicons',
  0, false, false, NULL, 6, false
),
(
  'daily_family_friends',
  '{"category_en": "Family & Friends", "category_tr": "Aile ve Arkadaşlar", "category_es": "Familia y Amigos", "category_pt": "Família e Amigos", "short_en": "Family", "short_tr": "Aile", "short_es": "Familia", "short_pt": "Família"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'people', 'Ionicons',
  0, false, false, NULL, 7, false
),
(
  'daily_intimacy',
  '{"category_en": "Closeness & Intimacy", "category_tr": "Yakınlık ve Mahremiyet", "category_es": "Cercanía e Intimidad", "category_pt": "Proximidade e Intimidade", "short_en": "Intimacy", "short_tr": "Yakınlık", "short_es": "Intimidad", "short_pt": "Intimidade"}'::jsonb,
  'daily_analysis', '#F6EEF9', 'flame', 'Ionicons',
  0, false, false, NULL, 8, false
)
ON CONFLICT (id) DO UPDATE SET
  labels = EXCLUDED.labels,
  group_id = EXCLUDED.group_id,
  color = EXCLUDED.color,
  icon_name = EXCLUDED.icon_name,
  icon_type = EXCLUDED.icon_type,
  coins_required = EXCLUDED.coins_required,
  is_premium = EXCLUDED.is_premium,
  recently_added = EXCLUDED.recently_added,
  difficulty = EXCLUDED.difficulty,
  order_index = EXCLUDED.order_index,
  is_listed = EXCLUDED.is_listed;

COMMIT;
