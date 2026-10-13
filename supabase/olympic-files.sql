-- Olympic tracker attachments: Metrc manifest PDFs fetched by the hourly Metrc feed.
-- Same trust model as olympic_save (supabase/olympic-tracker.sql): writing needs the edit token
-- (its sha256 hash lives in olympic_tracker_secret); anyone with the board link can read a file
-- BY EXACT NAME through olympic_get_file. No listing, no direct table access (RLS on, no policies).
-- Kept out of the state row so the board's 60-second poll never carries PDF bytes.

create table if not exists public.olympic_files (
  name text primary key check (name ~ '^[a-z0-9][a-z0-9._-]{2,100}$'),
  mime text not null check (mime in ('application/pdf')),
  bytes bytea not null check (octet_length(bytes) between 5 and 8388608),
  sha256 text not null,
  updated_at timestamptz not null default now()
);
alter table public.olympic_files enable row level security;

create or replace function public.olympic_put_file(p_token text, p_name text, p_mime text, p_b64 text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bytea;
begin
  if not exists (select 1 from public.olympic_tracker_secret
                 where token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex')) then
    raise exception 'bad token';
  end if;
  b := decode(p_b64, 'base64');
  if p_mime = 'application/pdf' and substring(b from 1 for 5) <> convert_to('%PDF-', 'utf8') then
    raise exception 'not a PDF';
  end if;
  insert into public.olympic_files (name, mime, bytes, sha256)
    values (p_name, p_mime, b, encode(sha256(b), 'hex'))
    on conflict (name) do update set mime = excluded.mime, bytes = excluded.bytes,
      sha256 = excluded.sha256, updated_at = now();
  return jsonb_build_object('ok', true, 'name', p_name, 'size', octet_length(b), 'sha256', encode(sha256(b), 'hex'));
end $$;
revoke all on function public.olympic_put_file(text, text, text, text) from public;
grant execute on function public.olympic_put_file(text, text, text, text) to anon, authenticated;

create or replace function public.olympic_get_file(p_name text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', name, 'mime', mime, 'sha256', sha256,
                            'b64', translate(encode(bytes, 'base64'), E'\n', ''))
  from public.olympic_files where name = p_name
$$;
revoke all on function public.olympic_get_file(text) from public;
grant execute on function public.olympic_get_file(text) to anon, authenticated;
