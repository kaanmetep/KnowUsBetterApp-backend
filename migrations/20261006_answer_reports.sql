-- Reports of typed answers flagged by players (App Store guideline 1.2).
-- Written only by the backend (service role); RLS with no policies blocks
-- every other client.

CREATE TABLE IF NOT EXISTS public.answer_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text NOT NULL,
  question_id text NOT NULL,
  reported_answer text NOT NULL,
  reported_name text,
  reporter_name text,
  reporter_app_user_id text,
  reason text,
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_reports_created_at_idx
  ON public.answer_reports (created_at DESC);

ALTER TABLE public.answer_reports ENABLE ROW LEVEL SECURITY;
