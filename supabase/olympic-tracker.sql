-- Olympic (Rio Verde) -> Filifera -> Nabis -> Olympic product tracker.
-- One shared state row; anyone with the link can view (anon select), but writes go
-- through olympic_save which checks a token only Gianni holds (sha256 hash stored in
-- olympic_tracker_secret, a table with RLS on and NO policies, so clients never see it).
-- p_rev is optimistic concurrency: a stale save returns the server state instead of clobbering.

create table if not exists public.olympic_tracker (
  id text primary key default 'main' check (id = 'main'),
  state jsonb not null,
  rev bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.olympic_tracker enable row level security;
drop policy if exists olympic_read on public.olympic_tracker;
create policy olympic_read on public.olympic_tracker for select to anon, authenticated using (true);

create table if not exists public.olympic_tracker_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.olympic_tracker_secret enable row level security;
-- token hash is inserted out-of-band, never committed to the repo

create or replace function public.olympic_save(p_token text, p_state jsonb, p_rev bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur public.olympic_tracker%rowtype;
begin
  if not exists (select 1 from public.olympic_tracker_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  select * into cur from public.olympic_tracker where id = 'main' for update;
  if not found then
    insert into public.olympic_tracker (id, state, rev) values ('main', p_state, 1);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;
  if cur.rev is distinct from p_rev then
    return jsonb_build_object('ok', false, 'conflict', true, 'rev', cur.rev, 'state', cur.state);
  end if;
  update public.olympic_tracker set state = p_state, rev = cur.rev + 1, updated_at = now()
    where id = 'main';
  return jsonb_build_object('ok', true, 'rev', cur.rev + 1);
end $$;
revoke all on function public.olympic_save(text, jsonb, bigint) from public;
grant execute on function public.olympic_save(text, jsonb, bigint) to anon, authenticated;
