-- Messages players send from inside the app instead of opening Mail:
-- feedback ("it could be better"), contact us, and data deletion requests.
--
-- Written by POST /api/support (the game server, service role). Read and
-- resolved in the admin panel's "Mesajlar" tab. Data deletion is never
-- automatic: the request lands here and an admin deletes the data by hand.

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  app_user_id text,
  kind text not null check (kind in ('feedback', 'contact', 'data_deletion')),
  message text,
  -- Optional: only when the player wants an answer.
  email text,
  app_version text,
  platform text,
  os_version text,
  language text,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists support_requests_status_created_idx
  on public.support_requests (status, created_at desc);
create index if not exists support_requests_app_user_idx
  on public.support_requests (app_user_id);

alter table public.support_requests enable row level security;
-- No policies: only the service role (the game server) reads and writes it.
