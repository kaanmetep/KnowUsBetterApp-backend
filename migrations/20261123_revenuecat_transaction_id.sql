-- RevenueCat once sent two NON_RENEWING_PURCHASE events (different event.id,
-- 200 ms apart) for a single coin purchase, and both were credited. The store
-- transaction id is the same for such copies, so it gets its own unique key:
-- a purchase now credits coins once per event AND once per store transaction.
--
-- Safe on existing data: old rows keep transaction_id NULL, and the partial
-- index ignores NULLs (events without a transaction id still dedupe on
-- event_id only). The backend works with or without this migration.

ALTER TABLE public.revenuecat_events
  ADD COLUMN IF NOT EXISTS transaction_id text;

CREATE UNIQUE INDEX IF NOT EXISTS revenuecat_events_transaction_id_key
  ON public.revenuecat_events (transaction_id)
  WHERE transaction_id IS NOT NULL;
