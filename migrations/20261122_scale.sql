-- "On a Scale" game mode: a new category group (= game mode) with two
-- categories, the regular one (free) and an "intimacy" one (2 coins).
--
-- How it plays: like know_each_other, every question is about one player,
-- taking turns (even rounds player 1, odd rounds player 2). The subject drags
-- a slider to where they see themselves; the partner drags it to where they
-- see the subject (their own view). The app shows the gap between the two. A round scores 100 minus the distance (0-100);
-- 90+ counts as "spot on". A round the subject didn't answer isn't scored.
-- The game ends with how well each player guessed the other (see utils/scale).
--
-- Questions: question_type 'choice', have_answers true, EXACTLY 2 options per
-- language = the slider's left end, then its right end. The text names the
-- subject with {{playerName}} in every language ("How adventurous is
-- {{playerName}} on holiday?"). correct_answer and match_weight stay NULL.
-- The admin panel locks the form to this; other questions are skipped.
-- Starter questions: scripts/questions/scale-starter.json (add.ts payloads).
--
-- Deploy the backend that knows "scale" BEFORE running this: an older server
-- would play these categories as regular two-option questions.
--
-- The categories start as a "Soon" teaser (coming_soon = true): store builds
-- show them with a "Soon" chip, while builds that send include=scale (the
-- one in App Review and later) get them as normal categories. Once that
-- build is live in the stores, make them normal for everyone; older builds
-- then get UPDATE_REQUIRED when they start one:
--   UPDATE public.categories SET coming_soon = false WHERE group_id = 'scale';
-- Only app builds that send the "scale" client feature can play; older builds
-- get UPDATE_REQUIRED when the game starts.
--
-- Add at least 10 playable questions to each category before anyone starts a
-- game; with fewer the game is just shorter, with none start-game returns
-- QUESTIONS_UNAVAILABLE.

BEGIN;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'scale',
  '{"category_en": "On a Scale", "category_tr": "Ölçek", "category_es": "En una escala", "category_pt": "Numa escala", "category_de": "Auf einer Skala", "category_it": "Su una scala", "category_pl": "Na skali", "category_fr": "Sur une échelle", "category_ja": "どのくらい？", "category_nl": "Op een schaal"}'::jsonb,
  7,
  'options-outline',
  'Ionicons'
)
ON CONFLICT (id) DO UPDATE SET
  labels = EXCLUDED.labels,
  order_index = EXCLUDED.order_index,
  icon_name = EXCLUDED.icon_name,
  icon_type = EXCLUDED.icon_type;

INSERT INTO public.categories (
  id, labels, group_id, color, icon_name, icon_type,
  coins_required, is_premium, recently_added, difficulty, order_index, is_listed,
  coming_soon
) VALUES
(
  'scale',
  '{"category_en": "On a Scale", "category_tr": "Ölçek", "category_es": "En una escala", "category_pt": "Numa escala", "category_de": "Auf einer Skala", "category_it": "Su una scala", "category_pl": "Na skali", "category_fr": "Sur une échelle", "category_ja": "どのくらい？", "category_nl": "Op een schaal", "short_en": "Scale", "short_tr": "Ölçek", "short_es": "Escala", "short_pt": "Escala", "short_de": "Skala", "short_it": "Scala", "short_pl": "Skala", "short_fr": "Échelle", "short_ja": "スケール", "short_nl": "Schaal"}'::jsonb,
  'scale',
  '#DCEAF7',
  'sliders',
  'FontAwesome6',
  0, false, true, NULL, 15, true,
  true
),
(
  'scale_intimacy',
  '{"category_en": "On a Scale", "category_tr": "Ölçek", "category_es": "En una escala", "category_pt": "Numa escala", "category_de": "Auf einer Skala", "category_it": "Su una scala", "category_pl": "Na skali", "category_fr": "Sur une échelle", "category_ja": "どのくらい？", "category_nl": "Op een schaal", "short_en": "Scale", "short_tr": "Ölçek", "short_es": "Escala", "short_pt": "Escala", "short_de": "Skala", "short_it": "Scala", "short_pl": "Skala", "short_fr": "Échelle", "short_ja": "スケール", "short_nl": "Schaal"}'::jsonb,
  'scale',
  '#C9DDF2',
  'temperature-high',
  'FontAwesome6',
  2, true, true, 'intimacy', 16, true,
  true
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
  is_listed = EXCLUDED.is_listed,
  coming_soon = EXCLUDED.coming_soon;

COMMIT;
