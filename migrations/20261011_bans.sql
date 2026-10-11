-- Banned players (services/banService.ts) and the reported player's wallet id
-- on answer reports, so a report can lead to a ban. Written only by the
-- backend (service role); RLS with no policies blocks every other client.

CREATE TABLE IF NOT EXISTS public.banned_users (
  app_user_id text PRIMARY KEY,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.banned_users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.answer_reports
  ADD COLUMN IF NOT EXISTS reported_app_user_id text;
