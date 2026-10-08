-- General knowledge (trivia) questions: a question with a correct_answer is
-- graded against it instead of comparing the two players' answers. NULL keeps
-- the existing behavior, so current categories are unaffected.
--
-- Shape depends on the question:
--   yes/no           (question_type 'choice', have_answers false): "yes" or "no"
--   multiple choice  (question_type 'choice', have_answers true):  the English answer text,
--                    exactly as it appears in answers.answers_en, e.g. "Paris"
--   typed answer     (question_type 'text'):  accepted answers, either
--                    ["Ankara"]  (any language, the first one is shown) or
--                    {"en": ["Blue"], "tr": ["Mavi"], "es": ["Azul"]}  (shown in the player's language)
--                    Typos and close wording are still accepted; the server judges them.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS correct_answer jsonb NULL;

ALTER TABLE public.questions
  DROP CONSTRAINT IF EXISTS questions_correct_answer_shape_check;
ALTER TABLE public.questions
  ADD CONSTRAINT questions_correct_answer_shape_check CHECK (
    correct_answer IS NULL
    OR (
      question_type = 'choice' AND have_answers = false
      AND correct_answer IN ('"yes"'::jsonb, '"no"'::jsonb)
    )
    OR (
      question_type = 'choice' AND have_answers = true
      AND jsonb_typeof(correct_answer) = 'string'
      AND (answers -> 'answers_en') ? (correct_answer #>> '{}')
    )
    OR (
      question_type = 'text'
      AND jsonb_typeof(correct_answer) IN ('array', 'object')
      AND correct_answer <> '[]'::jsonb
      AND correct_answer <> '{}'::jsonb
    )
  );

-- get_random_questions: do NOT add correct_answer to the RPC result. The
-- backend loads the key itself after picking questions, and only sends it to
-- clients once the round is over. If the function is RETURNS SETOF questions,
-- the extra column may come back unused; that is fine. Do not map it onto the
-- question object that goes out on next-question.
--
-- Examples (category 'the_mastermind' must exist in public.categories first):
--
-- Yes / no:
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, correct_answer, order_index)
-- VALUES (
--   'the_mastermind',
--   '{"text_en": "Is the Great Wall of China visible from space with the naked eye?", "text_tr": "Çin Seddi uzaydan çıplak gözle görülebilir mi?", "text_es": "¿Se ve la Gran Muralla China desde el espacio a simple vista?"}'::jsonb,
--   'choice', false, NULL, '"no"'::jsonb,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'the_mastermind')
-- );
--
-- Multiple choice:
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, correct_answer, order_index)
-- VALUES (
--   'the_mastermind',
--   '{"text_en": "What is the capital of Australia?", "text_tr": "Avustralya''nın başkenti neresidir?", "text_es": "¿Cuál es la capital de Australia?"}'::jsonb,
--   'choice', true,
--   '{"answers_en": ["Sydney", "Canberra", "Melbourne"], "answers_tr": ["Sidney", "Kanberra", "Melbourne"], "answers_es": ["Sídney", "Canberra", "Melbourne"]}'::jsonb,
--   '"Canberra"'::jsonb,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'the_mastermind')
-- );
--
-- Typed answer:
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, correct_answer, order_index)
-- VALUES (
--   'the_mastermind',
--   '{"text_en": "Which planet is known as the Red Planet?", "text_tr": "Kızıl Gezegen olarak bilinen gezegen hangisidir?", "text_es": "¿Qué planeta es conocido como el Planeta Rojo?"}'::jsonb,
--   'text', false, NULL,
--   '{"en": ["Mars"], "tr": ["Mars"], "es": ["Marte"]}'::jsonb,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'the_mastermind')
-- );
--
-- Category row (ungrouped categories do not show in the app picker — group_id
-- must match an existing public.category_groups.id):
-- INSERT INTO public.categories (
--   id, labels, group_id, color, icon_name, icon_type,
--   coins_required, is_premium, recently_added, difficulty, order_index, is_listed
-- ) VALUES (
--   'the_mastermind',
--   '{"category_en":"The Mastermind","category_tr":"Bilgi Yarışması","category_es":"El Cerebro","short_en":"Quiz","short_tr":"Yarışma","short_es":"Quiz"}'::jsonb,
--   'PUT_EXISTING_GROUP_ID_HERE',
--   '#0F8B8D',
--   'lightbulb',
--   'FontAwesome6',
--   0, false, true, NULL,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.categories),
--   true
-- );
