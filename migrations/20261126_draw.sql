-- "Draw It" game mode: a new category group (= game mode) with one
-- category, 1 coin per game (like the scale categories).
--
-- How it plays: Pictionary for two, as a team. Each turn both players draw
-- their own secret word at the same time, then each watches the partner's
-- drawing replay and picks the word from four options. Every right guess
-- counts the same (no speed bonus). 4 turns, no winner: the team's
-- "drawings guessed" count (see utils/draw).
--
-- Questions are WORDS: question_type 'choice', have_answers true, EXACTLY 4
-- answers per language, the first being the word and the other three
-- look-alikes it could be mistaken for when drawn badly ("pizza", "cookie",
-- "pie", "pancake"). No correct_answer or match_weight. texts hold a short
-- theme name ("Food"). Starter words: scripts/questions/draw-starter.json
-- (add.ts payloads). Writing rules: the write-questions skill in the app repo.
--
-- Deploy the backend that knows "draw" BEFORE running this: an older server
-- would play these words as plain multiple-choice questions.
--
-- The category starts as a "Soon" teaser (coming_soon = true): store builds
-- show it with a "Soon" chip, builds that send include=draw get it as a
-- normal category. Once that build is live in the stores:
--   UPDATE public.categories SET coming_soon = false WHERE group_id = 'draw';
-- Only app builds that send the "draw" client feature can play; older builds
-- get UPDATE_REQUIRED when the game starts.

BEGIN;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'draw',
  '{"category_en": "Draw It", "category_tr": "Çiz Bakalım", "category_es": "¡A dibujar!", "category_pt": "Desenha aí", "category_de": "Mal mal!", "category_it": "Disegna!", "category_pl": "Rysuj!", "category_fr": "Dessine !", "category_ja": "お絵かき", "category_nl": "Teken het!"}'::jsonb,
  8,
  'brush-outline',
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
  'draw',
  '{"category_en": "Draw It", "category_tr": "Çiz Bakalım", "category_es": "¡A dibujar!", "category_pt": "Desenha aí", "category_de": "Mal mal!", "category_it": "Disegna!", "category_pl": "Rysuj!", "category_fr": "Dessine !", "category_ja": "お絵かき", "category_nl": "Teken het!", "short_en": "Draw", "short_tr": "Çizim", "short_es": "Dibujo", "short_pt": "Desenho", "short_de": "Malen", "short_it": "Disegno", "short_pl": "Rysunek", "short_fr": "Dessin", "short_ja": "お絵かき", "short_nl": "Tekenen"}'::jsonb,
  'draw',
  '#FCE3D3',
  'palette',
  'FontAwesome6',
  1, true, true, NULL, 17, true,
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
