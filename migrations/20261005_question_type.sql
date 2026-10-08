-- Free-text ("type your answer") questions.
--   question_type = 'choice' -> existing behavior (have_answers decides yes/no vs multiple choice)
--   question_type = 'text'   -> both players type an answer; the server matches them by meaning
-- Every existing row becomes 'choice', so current games are unaffected.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'choice';

ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_question_type_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_question_type_check
  CHECK (question_type IN ('choice', 'text'));

-- A text question must not carry an answer list.
ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_text_has_no_answers_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_text_has_no_answers_check
  CHECK (question_type <> 'text' OR (have_answers = false AND answers IS NULL));

-- Example:
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, order_index)
-- VALUES (
--   'just_friends',
--   '{"text_en": "Describe your perfect weekend in one sentence.", "text_tr": "Mükemmel hafta sonunu tek cümleyle anlat.", "text_es": "Describe tu fin de semana perfecto en una frase."}'::jsonb,
--   'text', false, NULL,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'just_friends')
-- );
