-- "Who's more likely?" game mode: a new category group (= game mode) with two
-- categories, the regular one and an "intimacy" one.
--
-- How it plays: each player taps me / partner / both of us / neither of us.
-- The options are fixed and drawn by the app, so questions are stored as plain
-- choice questions with no answers: question_type 'choice', have_answers
-- false, answers NULL, correct_answer NULL. Text questions are skipped in this
-- mode. A round counts as agreed when both pointed at the same person.
--
-- categories.difficulty is free text; 'intimacy' shows an "Intimacy" chip in
-- the category picker the way 'hard' shows "Hard". No schema change needed.
--
-- Only app builds that send the "who_is_more_likely" client feature can play;
-- older builds get UPDATE_REQUIRED when the game starts.

BEGIN;

INSERT INTO public.category_groups (id, labels, order_index, icon_name, icon_type)
VALUES (
  'who_is_more_likely',
  '{"category_en": "Who''s More Likely?", "category_tr": "Kim Daha Yatkın?", "category_es": "¿Quién es más probable?"}'::jsonb,
  4,
  'hand-right-outline',
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
  'who_is_more_likely',
  '{"category_en": "Who''s More Likely?", "category_tr": "Kim Daha Yatkın?", "category_es": "¿Quién es más probable?", "short_en": "More Likely", "short_tr": "Kim Yapar?", "short_es": "¿Quién?"}'::jsonb,
  'who_is_more_likely',
  '#ECE5F6',
  'hand-point-right',
  'FontAwesome6',
  0, false, true, NULL, 10, true
),
(
  'who_is_more_likely_intimacy',
  '{"category_en": "Who''s More Likely?", "category_tr": "Kim Daha Yatkın?", "category_es": "¿Quién es más probable?", "short_en": "More Likely", "short_tr": "Kim Yapar?", "short_es": "¿Quién?"}'::jsonb,
  'who_is_more_likely',
  '#DCCDEE',
  'face-kiss-wink-heart',
  'FontAwesome6',
  3, true, true, 'intimacy', 11, true
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

-- Starter questions. Running this part twice adds them twice.

INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, order_index)
SELECT
  'who_is_more_likely',
  jsonb_build_object('text_en', v.en, 'text_tr', v.tr, 'text_es', v.es),
  'choice', false, NULL,
  (SELECT COALESCE(MAX(order_index), 0) FROM public.questions WHERE category_id = 'who_is_more_likely') + v.ord
FROM (VALUES
  (1,  'Who is more likely to forget an important date?', 'Önemli bir tarihi unutmaya kim daha yatkın?', '¿Quién es más probable que olvide una fecha importante?'),
  (2,  'Who is more likely to cry during a movie?', 'Film izlerken ağlamaya kim daha yatkın?', '¿Quién es más probable que llore viendo una película?'),
  (3,  'Who is more likely to get lost even with GPS?', 'GPS''e rağmen yolu kaybetmeye kim daha yatkın?', '¿Quién es más probable que se pierda incluso con GPS?'),
  (4,  'Who is more likely to apologize first after a fight?', 'Kavgadan sonra ilk özür dilemeye kim daha yatkın?', '¿Quién es más probable que pida perdón primero después de una pelea?'),
  (5,  'Who is more likely to spend all their money on something silly?', 'Bütün parasını saçma bir şeye harcamaya kim daha yatkın?', '¿Quién es más probable que gaste todo su dinero en una tontería?'),
  (6,  'Who is more likely to fall asleep first on movie night?', 'Film gecesinde ilk uyuyakalmaya kim daha yatkın?', '¿Quién es más probable que se duerma primero en una noche de películas?'),
  (7,  'Who is more likely to eat the last slice without asking?', 'Son dilimi sormadan yemeye kim daha yatkın?', '¿Quién es más probable que se coma el último trozo sin preguntar?'),
  (8,  'Who is more likely to plan a surprise trip?', 'Sürpriz bir tatil planlamaya kim daha yatkın?', '¿Quién es más probable que planee un viaje sorpresa?'),
  (9,  'Who is more likely to be late to their own party?', 'Kendi partisine geç kalmaya kim daha yatkın?', '¿Quién es más probable que llegue tarde a su propia fiesta?'),
  (10, 'Who is more likely to become famous one day?', 'Bir gün ünlü olmaya kim daha yatkın?', '¿Quién es más probable que llegue a la fama algún día?'),
  (11, 'Who is more likely to adopt a pet without asking the other?', 'Diğerine sormadan evcil hayvan sahiplenmeye kim daha yatkın?', '¿Quién es más probable que adopte una mascota sin preguntarle al otro?'),
  (12, 'Who is more likely to survive a zombie apocalypse?', 'Zombi kıyametinden sağ çıkmaya kim daha yatkın?', '¿Quién es más probable que sobreviva a un apocalipsis zombi?')
) AS v(ord, en, tr, es);

INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, order_index)
SELECT
  'who_is_more_likely_intimacy',
  jsonb_build_object('text_en', v.en, 'text_tr', v.tr, 'text_es', v.es),
  'choice', false, NULL,
  (SELECT COALESCE(MAX(order_index), 0) FROM public.questions WHERE category_id = 'who_is_more_likely_intimacy') + v.ord
FROM (VALUES
  (1,  'Who is more likely to make the first move tonight?', 'Bu gece ilk adımı atmaya kim daha yatkın?', '¿Quién es más probable que dé el primer paso esta noche?'),
  (2,  'Who is more likely to send a flirty text in the middle of the day?', 'Gün ortasında flörtöz bir mesaj atmaya kim daha yatkın?', '¿Quién es más probable que mande un mensaje coqueto a mitad del día?'),
  (3,  'Who is more likely to suggest trying something new in bed?', 'Yatakta yeni bir şey denemeyi önermeye kim daha yatkın?', '¿Quién es más probable que proponga probar algo nuevo en la cama?'),
  (4,  'Who is more likely to get jealous?', 'Kıskanmaya kim daha yatkın?', '¿Quién es más probable que sienta celos?'),
  (5,  'Who is more likely to start a kiss in public?', 'Herkesin önünde ilk öpmeye kim daha yatkın?', '¿Quién es más probable que empiece un beso en público?'),
  (6,  'Who is more likely to fall asleep right after cuddling?', 'Sarılıp yattıktan hemen sonra uyuyakalmaya kim daha yatkın?', '¿Quién es más probable que se duerma justo después de acurrucarse?'),
  (7,  'Who is more likely to have a secret fantasy they''ve never shared?', 'Hiç anlatmadığı gizli bir fantezisi olmaya kim daha yatkın?', '¿Quién es más probable que tenga una fantasía secreta que nunca ha contado?'),
  (8,  'Who is more likely to buy sexy lingerie as a surprise?', 'Sürpriz olarak seksi bir iç çamaşırı almaya kim daha yatkın?', '¿Quién es más probable que compre lencería sexy como sorpresa?'),
  (9,  'Who is more likely to say "I want you" first?', 'İlk "Seni istiyorum" demeye kim daha yatkın?', '¿Quién es más probable que diga "te deseo" primero?'),
  (10, 'Who is more likely to turn a massage into something more?', 'Bir masajı daha fazlasına dönüştürmeye kim daha yatkın?', '¿Quién es más probable que convierta un masaje en algo más?'),
  (11, 'Who is more likely to get shy talking about their desires?', 'Arzuları hakkında konuşurken utanmaya kim daha yatkın?', '¿Quién es más probable que le dé vergüenza hablar de sus deseos?'),
  (12, 'Who is more likely to sneak a kiss when no one is looking?', 'Kimse bakmazken kaçamak bir öpücük kondurmaya kim daha yatkın?', '¿Quién es más probable que robe un beso cuando nadie mira?')
) AS v(ord, en, tr, es);

COMMIT;

-- Adding more questions later (same shape for the intimacy category):
-- INSERT INTO public.questions (category_id, texts, question_type, have_answers, answers, order_index)
-- VALUES (
--   'who_is_more_likely',
--   '{"text_en": "Who is more likely to ...?", "text_tr": "... kim daha yatkın?", "text_es": "¿Quién es más probable que ...?"}'::jsonb,
--   'choice', false, NULL,
--   (SELECT COALESCE(MAX(order_index), 0) + 1 FROM public.questions WHERE category_id = 'who_is_more_likely')
-- );
