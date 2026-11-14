-- RevenueCat sends TRANSFER when an Apple account's purchases move to another
-- appUserId: a reinstall whose Keychain gave no id, or a second device on the
-- same Apple account. The coins left on the old ids move to the new one.
-- Recording the event and moving the coins happen in one transaction, so a
-- redelivered event (same id) moves nothing and a failed one can be retried.
-- Called only by the backend (service role).

create or replace function public.merge_transferred_wallets(
  p_event_id text,
  p_from text[],
  p_to text
)
returns table (status text, moved integer, new_balance integer)
language plpgsql
set search_path = public
as $$
declare
  source record;
  total integer := 0;
  balance_after integer;
begin
  insert into revenuecat_events (event_id, event_type, app_user_id, coins)
  values (p_event_id, 'TRANSFER', p_to, 0)
  on conflict (event_id) do nothing;
  if not found then
    return query select 'duplicate'::text, 0, null::integer;
    return;
  end if;

  for source in
    select app_user_id, balance
    from coins
    where app_user_id = any(p_from) and app_user_id <> p_to and balance > 0
    order by app_user_id
    for update
  loop
    update coins set balance = 0 where app_user_id = source.app_user_id;
    insert into coin_transactions (app_user_id, amount, transaction_type)
    values (source.app_user_id, source.balance, 'transfer_out');
    total := total + source.balance;
  end loop;

  if total = 0 then
    return query select 'nothing_to_move'::text, 0, null::integer;
    return;
  end if;

  insert into coins (app_user_id, balance)
  values (p_to, total)
  on conflict (app_user_id) do update set balance = coins.balance + excluded.balance
  returning balance into balance_after;
  insert into coin_transactions (app_user_id, amount, transaction_type)
  values (p_to, total, 'transfer_in');
  update revenuecat_events set coins = total where event_id = p_event_id;

  return query select 'moved'::text, total, balance_after;
end;
$$;

revoke execute on function public.merge_transferred_wallets(text, text[], text)
  from public, anon, authenticated;
