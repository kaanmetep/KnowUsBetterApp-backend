-- Questions each player has already played, so a new game picks ones neither
-- player has seen (services/questionService.ts). Written only by the backend
-- (service role); RLS with no policies blocks every other client.
--
-- One row per player and question; playing it again only moves seen_at.
-- Deleting a question deletes its rows.

CREATE TABLE IF NOT EXISTS public.seen_questions (
  app_user_id text NOT NULL,
  question_id uuid NOT NULL REFERENCES public.questions (id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_user_id, question_id)
);

ALTER TABLE public.seen_questions ENABLE ROW LEVEL SECURITY;

-- Like get_random_questions, but questions none of p_app_user_ids has seen
-- come first (in random order), then the ones seen longest ago. A category
-- whose questions were all seen still fills a game.
CREATE OR REPLACE FUNCTION public.get_fresh_questions(
  p_category_id text,
  p_count integer,
  p_app_user_ids text[]
)
RETURNS TABLE (
  id uuid,
  category_id text,
  texts jsonb,
  have_answers boolean,
  answers jsonb,
  question_type text,
  match_weight smallint,
  order_index integer
)
LANGUAGE sql
SET search_path = public
AS $$
  SELECT
    q.id,
    q.category_id,
    q.texts,
    q.have_answers,
    q.answers,
    q.question_type,
    q.match_weight,
    q.order_index
  FROM questions q
  LEFT JOIN (
    SELECT s.question_id, max(s.seen_at) AS last_seen
    FROM seen_questions s
    WHERE s.app_user_id = ANY (p_app_user_ids)
    GROUP BY s.question_id
  ) seen ON seen.question_id = q.id
  WHERE q.category_id = p_category_id
  ORDER BY seen.last_seen ASC NULLS FIRST, random()
  LIMIT p_count;
$$;

-- Ids of questions that no longer exist are skipped.
CREATE OR REPLACE FUNCTION public.mark_questions_seen(
  p_app_user_ids text[],
  p_question_ids uuid[]
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO seen_questions (app_user_id, question_id, seen_at)
  SELECT u.app_user_id, q.id, now()
  FROM (SELECT DISTINCT unnest(p_app_user_ids) AS app_user_id) u
  CROSS JOIN questions q
  WHERE q.id = ANY (p_question_ids)
  ON CONFLICT (app_user_id, question_id) DO UPDATE SET seen_at = EXCLUDED.seen_at;
$$;

REVOKE ALL ON FUNCTION public.get_fresh_questions(text, integer, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_questions_seen(text[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_fresh_questions(text, integer, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_questions_seen(text[], uuid[]) TO service_role;
