-- RevenueCat webhook events that already credited coins. RevenueCat can
-- deliver the same event more than once (same event.id); the primary key
-- makes the backend credit each purchase only once.
-- Written only by the backend (service role); RLS with no policies blocks
-- every other client.

CREATE TABLE IF NOT EXISTS public.revenuecat_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  app_user_id text NOT NULL,
  product_id text,
  coins integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revenuecat_events_app_user_id_idx
  ON public.revenuecat_events (app_user_id);

ALTER TABLE public.revenuecat_events ENABLE ROW LEVEL SECURITY;
