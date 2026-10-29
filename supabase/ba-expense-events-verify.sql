-- Checks for supabase/ba-expense-events.sql (BA app: event columns on expenses + rows synced from the books).
--
-- One transaction that ROLLS BACK, like supabase/ts-edits-verify.sql: it writes throwaway expenses, trips and hours
-- rows dated in 2099 (no pay period covers them, and no real row lives in those months, so the report functions see
-- only these), flips non_ba on the Automation profile and on one field BA for the length of the run, plays each
-- identity, records what happened, returns one pass/fail table, and undoes everything. Run it with write access as
-- the project owner (SQL editor, or the management API without read_only) AFTER ba-expense-events.sql; the API shows
-- the last result set, which is the pass/fail table. Every row must say pass = true.
--
-- Identities: the owner (no JWT: auth.uid() is null, as for a direct SQL or service-key write); Automation
-- a426046a-c0b4-42d0-ae13-6787df43ca77 (universal admin, the event sync's login); one active field BA (role 'ba').
-- Rows: S = a real store with a sales_key; '* Brand event' b4319cde-2358-4a1f-8abc-23eec20a2d69.
--   D1 2099-03-10  the report functions: a books row at S, then an app row at S
--   D2 2099-04-10  trg_force_non_ba with non_ba switched on
--   D3 2099-05-10  trg_expense_books_guard: who may set source, books_key, event_name and event_id

begin;

create temp table bee_results (
  seq serial primary key,
  test text not null,
  expected text not null,      -- a LIKE pattern
  got text
) on commit drop;

-- Run p_sql (one value) as p_uid (null = the owner, no JWT) and return it as text, or 'ERROR <sqlstate>'.
create function pg_temp.bee_as(p_uid uuid, p_sql text) returns text
language plpgsql as $f$
declare v_out text;
begin
  if p_uid is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', p_uid::text, true);
    execute 'set local role authenticated';
  end if;
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := 'ERROR ' || sqlstate;
  end;
  if p_uid is not null then
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  end if;
  return v_out;
end $f$;

create function pg_temp.bee_check(p_test text, p_expected text, p_got text) returns void
language sql as $f$ insert into bee_results (test, expected, got) values (p_test, p_expected, p_got) $f$;

do $$
declare
  v_auto  uuid := 'a426046a-c0b4-42d0-ae13-6787df43ca77';
  v_brand uuid := 'b4319cde-2358-4a1f-8abc-23eec20a2d69';
  v_nonba uuid := public.non_ba_disp();
  v_store uuid; v_key text; v_ba uuid; v_id text; v_got text;
  v_auto_nonba boolean; v_ba_nonba boolean;
  ins text := 'insert into public.expenses (ba_id, expense_date, dispensary_id, vendor, amount, category, payment, status, note, event_name, event_id, books_key, source) values ';
begin
  select id, sales_key into v_store, v_key from public.dispensaries
   where sales_key is not null and coalesce(retail, true) and not coalesce(private, false) and name not like '* %' and state is not null
   order by name limit 1;
  select id into v_ba from public.profiles where role = 'ba' and active and coalesce(non_ba, false) = false order by full_name limit 1;
  select non_ba into v_auto_nonba from public.profiles where id = v_auto;

  perform pg_temp.bee_check('0. the Automation profile, a store with a sales key, a field BA and the buckets exist', 't|t|t|t|t',
    concat_ws('|', v_auto_nonba is not null, v_store is not null, v_ba is not null,
      exists (select 1 from public.dispensaries where id = v_brand), v_nonba is not null));

  -- ── 1. columns and constraints ──
  perform pg_temp.bee_check('1a. the four columns exist as text', 'books_key:text,event_id:text,event_name:text,source:text',
    (select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns
      where table_schema = 'public' and table_name = 'expenses' and column_name in ('event_name', 'event_id', 'books_key', 'source')));
  perform pg_temp.bee_check('1b. books_key is a plain UNIQUE constraint', 'UNIQUE (books_key)',
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_books_key_key'));
  perform pg_temp.bee_check('1c. source allows only null or books', '%source IS NULL%source = ''books''%',
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.expenses'::regclass and conname = 'expenses_source_check'));
  perform pg_temp.bee_check('1d. a source other than books is refused', 'ERROR 23514', pg_temp.bee_as(null,
    ins || format('(%L, ''2099-03-10'', %L, ''x'', 1, ''Events'', ''company'', ''approved'', null, null, null, null, ''app'') returning id::text', v_auto, v_store)));

  -- ── 2. report functions (D1): a books row keeps its dollars and makes no visit ──
  v_id := pg_temp.bee_as(null, ins || format('(%L, ''2099-03-10'', %L, ''ZZ Vendor'', 123.45, ''Events'', ''company'', ''approved'', ''Event: ZZ BEE TEST (3/10/99)'', ''ZZ BEE TEST (3/10/99)'', ''zz-bee-event'', ''zz-bee:Purchase:1:1'', ''books'') returning id::text', v_auto, v_store));
  perform pg_temp.bee_check('2a. the owner (no JWT, like the service key) inserts a books row', '________-____-____-____-____________', v_id);
  perform pg_temp.bee_check('2b. the same books_key twice is refused', 'ERROR 23505', pg_temp.bee_as(null,
    ins || format('(%L, ''2099-03-11'', %L, ''ZZ Vendor'', 1, ''Events'', ''company'', ''approved'', null, null, null, ''zz-bee:Purchase:1:1'', ''books'') returning id::text', v_auto, v_store)));
  perform pg_temp.bee_check('2c. app rows without a books_key stay distinct (two NULLs)', '________-____-____-____-____________', pg_temp.bee_as(null,
    ins || format('(%L, ''2099-03-12'', null, ''ZZ'', 0, ''Other'', ''company'', ''draft'', null, null, null, null, null) returning id::text', v_auto)));
  perform pg_temp.bee_check('2d. ba_sales_metrics: the store gets the dollars as card, and no visit', '0|123.45',
    (select concat_ws('|', visits, card) from public.ba_sales_metrics('2099-03-01', '2099-03-31') where disp_id = v_store));
  perform pg_temp.bee_check('2e. ba_visit_detail lists no visit for it', '0',
    (select count(*)::text from public.ba_visit_detail('2099-03-01', '2099-03-31')));
  perform pg_temp.bee_check('2f. ba_visit_kinds lists no visit for it', '0',
    (select count(*)::text from public.ba_visit_kinds('2099-03-01', '2099-03-31')));
  perform pg_temp.bee_check('2g. ba_visit_days lists no visit for it', '0',
    (select count(*)::text from public.ba_visit_days('2099-03-01', '2099-03-31')));
  perform pg_temp.bee_check('2h. ba_sales_detail (the BA Spend drill) still shows it as a company-card line', 'Company card|123.45|%Event: ZZ BEE TEST (3/10/99)%',
    (select concat_ws('|', kind, amount, descr) from public.ba_sales_detail('2099-03-01', '2099-03-31', v_key) where kind = 'Company card'));
  -- an ordinary app row at the same store and day is a visit, as before
  perform pg_temp.bee_as(null, ins || format('(%L, ''2099-03-10'', %L, ''ZZ App'', 10, ''Meals'', ''company'', ''approved'', null, null, null, null, null) returning id::text', v_auto, v_store));
  perform pg_temp.bee_check('2i. an app row at the same store still counts: 1 visit, both amounts as card', '1|133.45',
    (select concat_ws('|', visits, card) from public.ba_sales_metrics('2099-03-01', '2099-03-31') where disp_id = v_store));
  perform pg_temp.bee_check('2j. ba_visit_detail: that visit, as a Store visit', '1|Store visit',
    (select concat_ws('|', count(*), max(activity)) from public.ba_visit_detail('2099-03-01', '2099-03-31')));
  perform pg_temp.bee_check('2k. ba_visit_kinds and ba_visit_days: one visit day each', '1|1',
    concat_ws('|', (select count(*) from public.ba_visit_kinds('2099-03-01', '2099-03-31')),
                   (select count(*) from public.ba_visit_days('2099-03-01', '2099-03-31'))));
  perform pg_temp.bee_check('2l. the report functions are still callable by anon and authenticated', 't|t|t|t',
    concat_ws('|', has_function_privilege('anon', 'public.ba_sales_metrics(date,date)', 'execute'),
      has_function_privilege('authenticated', 'public.ba_visit_detail(date,date)', 'execute'),
      has_function_privilege('anon', 'public.ba_visit_kinds(date,date)', 'execute'),
      has_function_privilege('anon', 'public.ba_visit_days(date,date)', 'execute')));

  -- ── 3. trg_force_non_ba (D2): with non_ba on, a books row keeps its link; everything else is re-filed as before ──
  update public.profiles set non_ba = true where id = v_auto;
  perform pg_temp.bee_check('3a. owner write: a books row at * Brand event stays there', v_brand::text, pg_temp.bee_as(null,
    ins || format('(%L, ''2099-04-10'', %L, ''ZZ'', 5, ''Events'', ''company'', ''approved'', null, null, null, ''zz-bee:Purchase:2:1'', ''books'') returning dispensary_id::text', v_auto, v_brand)));
  perform pg_temp.bee_check('3b. Automation''s own login: a books row at the store stays there', v_store::text, pg_temp.bee_as(v_auto,
    ins || format('(%L, ''2099-04-10'', %L, ''ZZ'', 6, ''Events'', ''company'', ''approved'', null, null, null, ''zz-bee:Purchase:3:1'', ''books'') returning dispensary_id::text', v_auto, v_store)));
  perform pg_temp.bee_check('3c. Automation''s login updates that books row: still at the store', v_store::text, pg_temp.bee_as(v_auto,
    format('update public.expenses set amount = 7 where books_key = ''zz-bee:Purchase:3:1'' returning dispensary_id::text')));
  perform pg_temp.bee_check('3d. an app row (no source) is re-filed to * Non-BA activity, as before', v_nonba::text, pg_temp.bee_as(null,
    ins || format('(%L, ''2099-04-10'', %L, ''ZZ'', 8, ''Meals'', ''company'', ''approved'', null, null, null, null, null) returning dispensary_id::text', v_auto, v_store)));
  perform pg_temp.bee_check('3e. trips still write through the trigger (no source column there)', 'Non-BA activity|' || v_nonba::text, pg_temp.bee_as(null,
    format('insert into public.trips (ba_id, trip_date, method, miles, dispensary_id, status) values (%L, ''2099-04-10'', ''manual'', 1, %L, ''draft'') returning concat_ws(''|'', kind, dispensary_id)', v_auto, v_store)));
  perform pg_temp.bee_check('3f. hours still write through the trigger', 'Non-BA activity|' || v_nonba::text, pg_temp.bee_as(null,
    format('insert into public.hours (ba_id, work_date, hours, source, status, dispensary_id) values (%L, ''2099-04-10'', 1, ''manual'', ''draft'', %L) returning concat_ws(''|'', kind, dispensary_id)', v_auto, v_store)));
  update public.profiles set non_ba = v_auto_nonba where id = v_auto;

  -- a field BA cannot use source 'books' to keep a store link they are not allowed to keep
  select non_ba into v_ba_nonba from public.profiles where id = v_ba;
  update public.profiles set non_ba = true where id = v_ba;
  perform pg_temp.bee_check('3g. a BA marking their own draft books is still re-filed to * Non-BA activity', v_nonba::text, pg_temp.bee_as(v_ba,
    ins || format('(%L, ''2099-04-10'', %L, ''ZZ'', 9, ''Meals'', ''company'', ''draft'', null, null, null, null, ''books'') returning dispensary_id::text', v_ba, v_store)));
  update public.profiles set non_ba = v_ba_nonba where id = v_ba;

  -- ── 4. the guard (D3): only the sync's login, an admin, the service key or SQL sets the four event columns ──
  perform pg_temp.bee_check('4a. the guard is the first BEFORE trigger on expenses, and reads the real caller (not security definer)',
    'a0_expense_books_guard,aa_force_non_ba,%|f',
    concat_ws('|', (select string_agg(tgname::text, ',' order by tgname::text collate "C") from pg_trigger
                     where tgrelid = 'public.expenses'::regclass and not tgisinternal),
                   (select prosecdef from pg_proc where oid = 'public.trg_expense_books_guard'::regproc)));
  perform pg_temp.bee_check('4b. a field BA''s insert is saved, and the four columns arrive empty', 'ZZ Ba|-|-|-|-', pg_temp.bee_as(v_ba,
    ins || format('(%L, ''2099-05-10'', null, ''ZZ Ba'', 12, ''Meals'', ''reimbursement'', ''draft'', null, ''ZZ FORGED (5/10/99)'', ''zz-forged'', ''zz-bee:Purchase:4:1'', ''books'') returning concat_ws(''|'', vendor, coalesce(source, ''-''), coalesce(books_key, ''-''), coalesce(event_name, ''-''), coalesce(event_id, ''-''))', v_ba)));
  v_id := pg_temp.bee_as(null, ins || format('(%L, ''2099-05-10'', null, ''ZZ Tagged'', 13, ''Meals'', ''reimbursement'', ''draft'', null, ''ZZ BEE TAG (5/10/99)'', ''zz-bee-tag'', ''zz-bee:Purchase:5:1'', null) returning id::text', v_ba));
  perform pg_temp.bee_check('4c. the owner (no JWT, like the service key) tags a BA''s row', 'ZZ BEE TAG (5/10/99)|zz-bee-tag|zz-bee:Purchase:5:1',
    (select concat_ws('|', event_name, event_id, books_key) from public.expenses where id::text = v_id));
  perform pg_temp.bee_check('4d. the BA edits that row: the amount changes, the tag stays, books is refused', '14|-|zz-bee:Purchase:5:1|ZZ BEE TAG (5/10/99)|zz-bee-tag', pg_temp.bee_as(v_ba,
    format('update public.expenses set amount = 14, source = ''books'', books_key = ''zz-bee:Purchase:9:9'', event_name = ''ZZ OTHER'', event_id = ''zz-other'' where id = %L returning concat_ws(''|'', amount::int, coalesce(source, ''-''), books_key, event_name, event_id)', v_id)));
  perform pg_temp.bee_check('4e. the BA cannot clear the tag either', 'zz-bee:Purchase:5:1|ZZ BEE TAG (5/10/99)|zz-bee-tag', pg_temp.bee_as(v_ba,
    format('update public.expenses set books_key = null, event_name = null, event_id = null where id = %L returning concat_ws(''|'', books_key, event_name, event_id)', v_id)));
  perform pg_temp.bee_check('4f. Automation''s login (an admin) retags that row', 'ZZ RETAG (5/11/99)|zz-retag', pg_temp.bee_as(v_auto,
    format('update public.expenses set event_name = ''ZZ RETAG (5/11/99)'', event_id = ''zz-retag'' where id = %L returning concat_ws(''|'', event_name, event_id)', v_id)));
  perform pg_temp.bee_check('4g. Automation''s login writes a books row with all four columns', 'books|zz-bee:Purchase:6:1|ZZ BEE TEST (3/10/99)|zz-bee-event', pg_temp.bee_as(v_auto,
    ins || format('(%L, ''2099-05-10'', %L, ''ZZ'', 15, ''Events'', ''company'', ''approved'', null, ''ZZ BEE TEST (3/10/99)'', ''zz-bee-event'', ''zz-bee:Purchase:6:1'', ''books'') returning concat_ws(''|'', source, books_key, event_name, event_id)', v_auto, v_brand)));
end $$;

select seq, test, expected, got, coalesce(got like expected, false) as pass from bee_results order by seq;

rollback;
