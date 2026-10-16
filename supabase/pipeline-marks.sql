-- Production Pipeline page (pipeline.html): the red marks on the DISTRO PIPELINE tab.
-- The page reads the tab as a CSV export, which keeps no formatting, so it can't see what Victoria marks red. A job
-- on Gianni's Mac (~/ar-automation/pipeline-marks-sync.mjs, every 5 minutes, only when the sheet changed) reads the
-- tab's formatting through the Sheets API with the bookkeeping service account and sends the cells that are red
-- (red fill, red text, or red words inside the text) through pipeline_marks_save() (token-gated; the token hash is
-- seeded out-of-band, never committed). Each mark keeps the cell's text, so the page only paints a cell when its
-- text still matches (rows Victoria inserts between two runs never shift a mark onto the wrong item).
-- Readers: the same accounts as the Batches view (pipeline_can_view(), from pipeline-batches.sql). Safe to re-run.

create table if not exists public.pipeline_marks (
  r      int not null,                 -- row in the tab, 0-based, as in the CSV export (hidden rows included)
  c      int not null,                 -- column, 0-based
  fill   boolean not null default false,   -- red background
  text   boolean not null default false,   -- the whole text is red
  part   boolean not null default false,   -- some words are red
  strike boolean not null default false,   -- struck through (kept for later; the page doesn't use it yet)
  txt    text not null,                -- the cell's text, to check the mark still belongs to it
  primary key (r, c)
);
comment on table public.pipeline_marks is
  'Red cells of the DISTRO PIPELINE tab for the Production Pipeline page. Written by '
  '~/ar-automation/pipeline-marks-sync.mjs via pipeline_marks_save(); read by pipeline_can_view() accounts.';
alter table public.pipeline_marks enable row level security;
drop policy if exists pipeline_marks_select on public.pipeline_marks;
create policy pipeline_marks_select on public.pipeline_marks
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_marks_meta (
  id             int primary key default 1 check (id = 1),
  synced_at      timestamptz,   -- the job last ran
  changed_at     timestamptz,   -- a run last changed the marks
  sheet_modified timestamptz,   -- the workbook's last edit when the marks were read
  marks          int
);
alter table public.pipeline_marks_meta enable row level security;
drop policy if exists pipeline_marks_meta_select on public.pipeline_marks_meta;
create policy pipeline_marks_meta_select on public.pipeline_marks_meta
  for select to authenticated using (public.pipeline_can_view());

create table if not exists public.pipeline_marks_secret (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);
alter table public.pipeline_marks_secret enable row level security;   -- no policies: nobody reads it

-- p_rows: every red cell the tab has now (null = the sheet hasn't changed: only the sync time is stamped).
-- The set is replaced as a whole.
create or replace function public.pipeline_marks_save(p_token text, p_rows jsonb, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if not exists (select 1 from public.pipeline_marks_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  if p_rows is not null then
    if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be the list of red cells'; end if;
    if exists (select 1 from jsonb_array_elements(p_rows) x
               where coalesce(x->>'r', '') !~ '^[0-9]+$' or coalesce(x->>'c', '') !~ '^[0-9]+$' or x->>'txt' is null) then
      raise exception 'every mark needs r, c and txt';
    end if;
    insert into public.pipeline_marks as m (r, c, fill, text, part, strike, txt)
    select (x->>'r')::int, (x->>'c')::int, coalesce((x->>'fill')::boolean, false), coalesce((x->>'text')::boolean, false),
           coalesce((x->>'part')::boolean, false), coalesce((x->>'strike')::boolean, false), x->>'txt'
      from jsonb_array_elements(p_rows) x
    on conflict (r, c) do update set fill = excluded.fill, text = excluded.text, part = excluded.part,
      strike = excluded.strike, txt = excluded.txt;
    get diagnostics n = row_count;
    -- cells no longer red (or emptied) are the ones not sent this time
    delete from public.pipeline_marks m
     where not exists (select 1 from jsonb_array_elements(p_rows) x where (x->>'r')::int = m.r and (x->>'c')::int = m.c);
  end if;
  insert into public.pipeline_marks_meta as m (id, synced_at, changed_at, sheet_modified, marks)
  values (1, now(), case when p_rows is not null then now() end, (p_meta->>'sheet_modified')::timestamptz,
          case when p_rows is not null then n end)
  on conflict (id) do update set synced_at = now(),
    changed_at = case when p_rows is not null then now() else m.changed_at end,
    sheet_modified = coalesce(excluded.sheet_modified, m.sheet_modified),
    marks = coalesce(excluded.marks, m.marks);
  return jsonb_build_object('ok', true, 'marks', n);
end $$;
revoke all on function public.pipeline_marks_save(text, jsonb, jsonb) from public;
grant execute on function public.pipeline_marks_save(text, jsonb, jsonb) to anon, authenticated;
