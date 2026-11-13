-- Production Pipeline page (pipeline.html): flags people have dismissed on the Production schedule.
-- The board flags a past day the sheet planned pre-rolls or jars and nobody logged that work in the task tracker
-- ("Not logged" in the lane's task tracker row). When the work didn't happen, or was moved, anyone who can open the
-- page dismisses the flag, for everyone, and Undo brings it back. A dismissal names exactly one lane and one day.
-- Readers: pipeline_can_view() accounts (pipeline-batches.sql). Writes only through pipeline_flag_dismiss().
-- Safe to re-run. Applied by the Pipeline deploy workflow as pipeline_owner (supabase/pipeline-order.txt).
set role pipeline_owner;

create table if not exists public.pipeline_flag_dismissals (
  kind         text not null,                      -- 'nolog': planned on the sheet, nothing in the task tracker
  ref          text not null,                      -- which one: 'prerolls|2026-11-09' (lane|day)
  dismissed_by text not null,                      -- the signed-in account's email
  dismissed_at timestamptz not null default now(),
  primary key (kind, ref)
);
comment on table public.pipeline_flag_dismissals is
  'Production schedule flags dismissed from the Production Pipeline page (pipeline.html). Written only by '
  'pipeline_flag_dismiss(); read by pipeline_can_view() accounts.';
alter table public.pipeline_flag_dismissals enable row level security;
revoke all on table public.pipeline_flag_dismissals from anon;
revoke insert, update, delete, truncate, references, trigger on table public.pipeline_flag_dismissals from authenticated;
drop policy if exists pipeline_flag_dismissals_select on public.pipeline_flag_dismissals;
create policy pipeline_flag_dismissals_select on public.pipeline_flag_dismissals
  for select to authenticated using (public.pipeline_can_view());

-- p_on true dismisses the flag (a second dismissal keeps the first one's name and time); false brings it back.
-- Returns the dismissal as it now stands, or null when the flag is showing again.
create or replace function public.pipeline_flag_dismiss(p_kind text, p_ref text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_who text := public.pipeline_jwt_email();
  v_day date;
  v_row public.pipeline_flag_dismissals;
begin
  if not public.pipeline_can_view() or coalesce(v_who, '') = '' then
    raise exception 'Only accounts that can open the Production Pipeline page can dismiss its flags.';
  end if;
  if p_kind is distinct from 'nolog' or coalesce(p_ref, '') !~ '^(prerolls|jars)\|[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'That is not a flag this page can dismiss.';
  end if;
  begin
    v_day := split_part(p_ref, '|', 2)::date;
  exception when others then
    raise exception 'That is not a flag this page can dismiss.';
  end;
  if p_on is null then raise exception 'Say whether to dismiss the flag or bring it back.'; end if;
  if p_on then
    -- after today in Los Angeles: no browser anywhere has reached that day yet (one east of LA may be on LA's tomorrow)
    if v_day > (now() at time zone 'America/Los_Angeles')::date then
      raise exception 'Only a past day can be flagged, so there is nothing to dismiss yet.';
    end if;
    insert into public.pipeline_flag_dismissals (kind, ref, dismissed_by)
    values (p_kind, p_ref, v_who)
    on conflict (kind, ref) do nothing;
  else
    delete from public.pipeline_flag_dismissals where kind = p_kind and ref = p_ref;
  end if;
  select * into v_row from public.pipeline_flag_dismissals where kind = p_kind and ref = p_ref;
  if not found then return null; end if;
  return jsonb_build_object('kind', v_row.kind, 'ref', v_row.ref, 'dismissed_by', v_row.dismissed_by,
                            'dismissed_at', v_row.dismissed_at);
end $$;
revoke all on function public.pipeline_flag_dismiss(text, text, boolean) from public, anon;
grant execute on function public.pipeline_flag_dismiss(text, text, boolean) to authenticated;

reset role;
