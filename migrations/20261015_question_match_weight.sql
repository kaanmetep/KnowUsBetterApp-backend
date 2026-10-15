-- How much a question counts toward the "see your match" percentage (1-10).
-- NULL = default weight (5, see DEFAULT_MATCH_WEIGHT in src/types.ts), so
-- existing questions don't need a value and a game where nothing is weighted
-- scores exactly as before. Only see_your_match games read it; know_each_other
-- and who_knows_better always count every question the same.
--
-- The percentage is matched weight / total weight of the game's questions, e.g.
-- matching on a 9 and missing a 2 is worth more than the other way around.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS match_weight smallint NULL;

ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_match_weight_range_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_match_weight_range_check
  CHECK (match_weight IS NULL OR match_weight BETWEEN 1 AND 10);

-- Trivia questions are graded against an answer key, never weighted.
ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_match_weight_not_trivia_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_match_weight_not_trivia_check
  CHECK (match_weight IS NULL OR correct_answer IS NULL);

-- get_random_questions needs no change: the backend reads match_weight itself
-- when the RPC result doesn't include it.
--
-- Examples:
-- UPDATE public.questions SET match_weight = 9
--  WHERE id = '00000000-0000-0000-0000-000000000000';
--
-- Review a category's weights:
-- SELECT id, texts ->> 'text_tr' AS soru, COALESCE(match_weight, 5) AS agirlik
--   FROM public.questions
--  WHERE category_id = 'spicy'
--  ORDER BY agirlik DESC, order_index;
