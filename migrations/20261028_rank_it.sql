-- "Rank It" game mode: a new category group (= game mode) with two
-- categories, the regular one (free) and an "intimacy" one (2 coins).
--
-- How it plays: each player drags the question's options into an order, from
-- first place to last. The two orders are compared pair by pair (Kendall tau):
-- the round scores 0-100 and the game's percentage is the average. A round
-- counts as matched only when both orders are identical.
--
-- Questions are added from the admin panel (or by hand). They must be
-- multiple choice: question_type 'choice', have_answers true, 3 to 5 options
-- per language (same count and order in every language), correct_answer NULL,
-- match_weight NULL. Questions with fewer or more options are skipped in this
-- mode. Write each option so it reads well on its own, and say the direction
-- in the question ("from most to least ...").
--
-- Deploy the backend that knows "rank_it" BEFORE running this: an older
-- server would play these categories as regular multiple choice.
-- Only app builds that send the "rank_it" client feature can play; older
-- builds get UPDATE_REQUIRED when the game starts.
--
-- Add at least 5 playable questions to each category before anyone starts a
-- game; otherwise start-game returns QUESTIONS_UNAVAILABLE.

BEGIN;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'rank_it',
  '{"category_en": "Rank It", "category_tr": "Sırala Bakalım", "category_es": "Ordénalo"}'::jsonb,
  5,
  'podium-outline',
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
  'rank_it',
  '{"category_en": "Rank It", "category_tr": "Sırala Bakalım", "category_es": "Ordénalo", "short_en": "Rank It", "short_tr": "Sırala", "short_es": "Ordena"}'::jsonb,
  'rank_it',
  '#DDEFE9',
  'ranking-star',
  'FontAwesome6',
  0, false, true, NULL, 12, true
),
(
  'rank_it_intimacy',
  '{"category_en": "Rank It", "category_tr": "Sırala Bakalım", "category_es": "Ordénalo", "short_en": "Rank It", "short_tr": "Sırala", "short_es": "Ordena"}'::jsonb,
  'rank_it',
  '#C5E4DA',
  'heart-pulse',
  'FontAwesome6',
  2, true, true, 'intimacy', 13, true
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

-- Questions: use the admin panel. Pick rank_it or rank_it_intimacy; the form
-- locks to multiple choice with 3-5 options. Hand-written example:
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, order_index)
-- VALUES (
--   'rank_it',
--   '{"text_en": "Rank these from most to least ...", "text_tr": "Bunları en ...dan en aza doğru sırala.", "text_es": "Ordena esto de más a menos ..."}'::jsonb,
--   'choice', true,
--   '{"answers_en": ["A", "B", "C", "D"], "answers_tr": ["A", "B", "C", "D"], "answers_es": ["A", "B", "C", "D"]}'::jsonb,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'rank_it')
-- );
