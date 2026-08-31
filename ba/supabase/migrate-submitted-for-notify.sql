-- ── Tell the BA when someone submits their period for them ─────────────────
-- The submissions trigger already emails the admin on a submission and on an approval.
-- It said nothing to the BA — so a manager submitting on their behalf made their period
-- read-only with no notice. That is exactly how Terrance lost the ability to enter his
-- last Friday, and he reported it as the period having "submitted on its own".
--
-- Adds a third branch: a submission whose submitted_by is somebody OTHER than the BA
-- emails the BA, naming who did it.
--
-- Run in the Supabase SQL editor (project dhiqhgtmelxwelyoowle). Safe to re-run.

create or replace function public.trg_submission_notify()
 returns trigger language plpgsql security definer set search_path to 'public','vault','net' as $function$
begin
  -- (1) a real (re)submission: INSERT as submitted, or a transition INTO 'submitted'
  -- that is not an admin undoing an approval (approved->submitted)
  if new.status = 'submitted' and (tg_op = 'INSERT'
       or (old.status is distinct from 'submitted' and old.status is distinct from 'approved')) then
    perform net.http_post(
      url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
      headers := jsonb_build_object('Content-Type','application/json',
        'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
      body := jsonb_build_object('job','submitted','ba_id',new.ba_id,'period_id',new.period_id));

    -- (1b) …and if a MANAGER did it, tell the BA their period is now read-only.
    if new.submitted_by is not null and new.submitted_by <> new.ba_id then
      perform net.http_post(
        url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
        headers := jsonb_build_object('Content-Type','application/json',
          'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
        body := jsonb_build_object('job','submitted_for','ba_id',new.ba_id,'period_id',new.period_id,
                                   'submitted_by',new.submitted_by));
    end if;
  end if;

  -- (2) an APPROVAL. Fires on any transition into 'approved'.
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform net.http_post(
      url := 'https://dhiqhgtmelxwelyoowle.supabase.co/functions/v1/ba-notify',
      headers := jsonb_build_object('Content-Type','application/json',
        'x-notify-secret',(select decrypted_secret from vault.decrypted_secrets where name='ba_notify_secret')),
      body := jsonb_build_object('job','approved','ba_id',new.ba_id,'period_id',new.period_id,
                                 'approved_by',new.approved_by,
                                 'was_submitted', new.submitted_at is not null));
  end if;
  return new;
end; $function$;

-- The guard strips admin-only columns from end-user writes; submitted_by must be
-- protected the same way approved_by is, or a BA could forge who submitted their period.
create or replace function public.trg_submission_guard() returns trigger language plpgsql as $function$
begin
  if (not public.req_is_enduser()) or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.approved_by := null; new.approved_at := null;
    new.submitted_by := new.ba_id;          -- a BA submitting can only be themselves
  else
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.submitted_by := coalesce(old.submitted_by, new.ba_id);
  end if;
  return new;
end; $function$;
