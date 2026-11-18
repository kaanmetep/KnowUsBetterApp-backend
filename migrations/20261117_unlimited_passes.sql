-- Weekly "Unlimited" subscription: who has it and until when.
--
-- Written by the RevenueCat webhook (INITIAL_PURCHASE, RENEWAL, CANCELLATION,
-- EXPIRATION, ...) and, as a fallback while a webhook is still on its way, by
-- a direct check against RevenueCat's API. The game server reads it when a
-- host starts a paid category: a room with an active pass plays for free.

create table if not exists public.unlimited_passes (
  app_user_id text primary key,
  product_id text not null,
  expires_at timestamptz not null,
  -- false once the user turned auto-renew off; the pass still runs until expires_at.
  will_renew boolean not null default true,
  -- RevenueCat's event_timestamp_ms of the event that wrote this row, so an
  -- older event delivered late can't overwrite a newer one.
  last_event_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists unlimited_passes_expires_at_idx
  on public.unlimited_passes (expires_at);

alter table public.unlimited_passes enable row level security;
-- No policies: only the service role (the game server) reads and writes it.
