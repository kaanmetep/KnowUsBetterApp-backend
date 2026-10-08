-- One secret per appUserId, issued by POST /api/identity/claim. Only its
-- SHA-256 is stored; the app keeps the token and sends it with coin requests.
create table if not exists public.app_user_credentials (
  app_user_id text primary key,
  token_hash text not null,
  created_at timestamptz not null default now(),
  -- First time the app used the token; until then a lost claim can be re-issued.
  confirmed_at timestamptz
);

alter table public.app_user_credentials enable row level security;
