-- Olympic tracker attachments, part 2: a plain link that returns the PDF itself, so the board's
-- paperclip is an ordinary <a href> (works in a new tab, on phones, and for downloads; no pop-ups,
-- no in-memory blobs). PostgREST serves a function returning the "*/*" domain as raw bytes with the
-- headers it sets. Read-only and by exact name, same as olympic_get_file (supabase/olympic-files.sql).
--   GET /rest/v1/rpc/olympic_file?p_name=manifest-0011673135.pdf&apikey=<publishable key>

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = '*/*' and n.nspname = 'public') then
    create domain public."*/*" as bytea;
  end if;
end $$;

create or replace function public.olympic_file(p_name text)
returns public."*/*" language plpgsql stable security definer set search_path = public as $$
declare f public.olympic_files%rowtype;
begin
  select * into f from public.olympic_files where name = p_name;
  if not found then raise sqlstate 'PT404' using message = 'not found'; end if;
  perform set_config('response.headers', json_build_array(
    json_build_object('Content-Type', f.mime),
    json_build_object('Content-Disposition', format('inline; filename="%s"', f.name)),
    json_build_object('Cache-Control', 'public, max-age=3600'))::text, true);
  return f.bytes;
end $$;
revoke all on function public.olympic_file(text) from public;
grant execute on function public.olympic_file(text) to anon, authenticated;

notify pgrst, 'reload schema';
