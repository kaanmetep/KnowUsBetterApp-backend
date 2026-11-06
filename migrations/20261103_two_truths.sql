-- "Two Truths & a Lie" game mode: a new category group (= game mode) with a
-- single category (1 coin).
--
-- How it plays (see src/utils/twoTruths.ts): 3 turns. Each turn both players
-- write three statements about themselves at the same time, two true and one
-- a lie, on the turn's topic. Then both see the partner's statements (in a
-- shuffled order) and pick the lie. Catching the partner's lie and fooling
-- the partner are a point each; the higher score wins.
--
-- Questions are only the turn's topic, shown on the card while writing and
-- guessing. They are stored as plain choice questions with no answers:
-- question_type 'choice', have_answers false, answers NULL, correct_answer
-- NULL, match_weight NULL. Keep each one a short noun phrase addressed to the
-- player ("Your childhood"), not a question.
--
-- Deploy the backend that knows "two_truths" BEFORE running this: an older
-- server would play these categories as yes/no questions.
-- Only app builds that send the "two_truths" client feature can play; older
-- builds get UPDATE_REQUIRED when the game starts.

BEGIN;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'two_truths',
  '{"category_en": "Two Truths & a Lie", "category_tr": "İki Doğru Bir Yalan", "category_es": "Dos Verdades y una Mentira", "category_pt": "Duas Verdades e uma Mentira"}'::jsonb,
  6,
  'finger-print-outline',
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
  'two_truths',
  '{"category_en": "Two Truths & a Lie", "category_tr": "İki Doğru Bir Yalan", "category_es": "Dos Verdades y una Mentira", "category_pt": "Duas Verdades e uma Mentira", "short_en": "Truth or Lie", "short_tr": "Doğru mu?", "short_es": "¿Verdad?", "short_pt": "Verdade?"}'::jsonb,
  'two_truths',
  '#E3E7FA',
  'user-secret',
  'FontAwesome6',
  1, true, true, NULL, 14, true
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

-- Topics are added from the admin panel (Questions → category "two_truths").
