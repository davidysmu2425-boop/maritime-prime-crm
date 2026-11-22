-- Maritime Prime CRM - database setup for Supabase.
-- Run this once: Supabase dashboard > SQL Editor > New query > paste everything > Run.
-- It is safe to run again later (for example after an update).

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['staff','leads','jobs','workers','settings','clocks'] loop
    execute format('create table if not exists public.%I (
      id text primary key,
      data jsonb not null default ''{}''::jsonb,
      by text,
      updated_at timestamptz not null default now())', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
alter table public.profiles enable row level security;

-- ---------------------------------------------------------------- who am I
create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as
$$ select email from profiles where user_id = auth.uid() $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select s.data->>'role' from staff s where s.id = public.my_email() $$;

create or replace function public.is_office() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(public.my_role() in ('owner','admin','estimator'), false) $$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(public.my_role() in ('owner','admin'), false) $$;

create or replace function public.my_worker_id() returns text
language sql stable security definer set search_path = public as
$$ select w.id from workers w
   where public.my_email() is not null and lower(trim(w.data->>'email')) = public.my_email()
   limit 1 $$;

create or replace function public.my_crew() returns text
language sql stable security definer set search_path = public as
$$ select nullif(w.data->>'crew', '') from workers w where w.id = public.my_worker_id() $$;

create or replace function public.can_access_job(jid text) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_office() or exists (
     select 1 from jobs j
     where j.id = jid and public.my_crew() is not null and j.data->>'crew' = public.my_crew()) $$;

-- Called right after sign-in. Links the login to the team list by its
-- confirmed email address. The very first person to sign in becomes the owner.
create or replace function public.claim_profile() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u_email text; u_conf timestamptz; em text; r text; nm text; wid text;
begin
  if auth.uid() is null then return null; end if;
  select email, email_confirmed_at into u_email, u_conf from auth.users where id = auth.uid();
  if u_email is null or u_conf is null then
    return jsonb_build_object('error', 'unconfirmed');
  end if;
  em := lower(trim(u_email));
  insert into profiles (user_id, email) values (auth.uid(), em)
    on conflict (user_id) do update set email = excluded.email;
  if not exists (select 1 from staff) then
    insert into staff (id, data) values (em, jsonb_build_object('email', em, 'name', 'Owner', 'role', 'owner'));
  end if;
  select data->>'role', data->>'name' into r, nm from staff where id = em;
  if r is not null then
    return jsonb_build_object('kind', 'account', 'role', r, 'name', coalesce(nullif(nm, ''), 'Office'), 'email', em);
  end if;
  select id into wid from workers where lower(trim(data->>'email')) = em limit 1;
  if wid is not null then
    return jsonb_build_object('kind', 'worker', 'id', wid, 'email', em);
  end if;
  return jsonb_build_object('error', 'not_listed', 'email', em);
end $$;

-- ---------------------------------------------------------------- access rules
-- Office accounts (owner, managers, sales) work with everything.
-- Painters get NO direct access to leads, jobs, prices or the team list;
-- they only use the two functions further down.
do $$
declare t text;
begin
  foreach t in array array['leads','jobs','workers','settings'] loop
    execute format('drop policy if exists office_all on public.%I', t);
    execute format('create policy office_all on public.%I for all to authenticated
      using (public.is_office()) with check (public.is_office())', t);
  end loop;
end $$;

drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated using (public.is_office());
drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff for insert to authenticated with check (public.is_manager());
drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff for update to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists staff_delete on public.staff;
create policy staff_delete on public.staff for delete to authenticated using (public.is_manager());

drop policy if exists clocks_all on public.clocks;
create policy clocks_all on public.clocks for all to authenticated
  using (public.is_office() or id = public.my_worker_id())
  with check (public.is_office() or id = public.my_worker_id());

-- ---------------------------------------------------------------- painters
-- Everything a painter's phone needs: their crew, and their crew's scheduled
-- jobs WITHOUT prices, costs, margins or office-only files.
create or replace function public.crew_snapshot() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare wid text := public.my_worker_id(); c text;
begin
  if wid is null then return null; end if;
  select nullif(data->>'crew', '') into c from workers where id = wid;
  return jsonb_build_object(
    'me', wid,
    'crew', c,
    'clock', (select data from clocks where id = wid),
    'workers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', w.id, 'name', w.data->'name', 'role', w.data->'role', 'crew', w.data->'crew',
        'phone', w.data->'phone',
        'off', case when w.id = wid then coalesce(w.data->'off', '[]'::jsonb) else '[]'::jsonb end))
      from workers w where w.id = wid or (c is not null and w.data->>'crew' = c)), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', j.id, 'customer', j.data->'customer', 'address', j.data->'address', 'phone', j.data->'phone',
        'type', j.data->'type', 'category', j.data->'category', 'crew', j.data->'crew',
        'start', j.data->'start', 'end', j.data->'end', 'days', j.data->'days',
        'status', j.data->'status', 'confirm', j.data->'confirm',
        'notes', j.data->'notes', 'specs', j.data->'specs', 'log', j.data->'log',
        'files', coalesce((
          select jsonb_agg(f) from jsonb_array_elements(
            case when jsonb_typeof(j.data->'files') = 'array' then j.data->'files' else '[]'::jsonb end) f
          where f->>'kind' in ('media', 'extra')), '[]'::jsonb)))
      from jobs j
      where c is not null and j.data->>'crew' = c
        and j.data->>'start' is not null
        and j.data->>'end' >= to_char(current_date - 14, 'YYYY-MM-DD')), '[]'::jsonb));
end $$;

-- The only changes a painter can make to a job: log hours, add a receipt,
-- add photos/videos. Only on jobs assigned to their own crew.
create or replace function public.worker_job_update(jid text, kind text, payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  wid text := public.my_worker_id(); c text; d jsonb; st int; ex jsonb; f jsonb; hrs numeric; amt numeric;
begin
  if wid is null then raise exception 'Not signed in as a crew member'; end if;
  select nullif(data->>'crew', '') into c from workers where id = wid;
  select data into d from jobs where id = jid and c is not null and data->>'crew' = c for update;
  if d is null then raise exception 'That job is not assigned to your crew'; end if;
  st := coalesce((d->>'status')::int, 0);

  -- freeze the expense list the same way the office app does
  if not (d ? 'expenses') then
    if st >= 1 then
      select coalesce(jsonb_agg(jsonb_build_object('label', m->'item', 'amount', m->'cost')), '[]'::jsonb)
        into ex from jsonb_array_elements(coalesce(d->'materials', '[]'::jsonb)) m;
    else
      ex := '[]'::jsonb;
    end if;
    d := jsonb_set(d, '{expenses}', ex);
  end if;

  if kind = 'hours' then
    hrs := (payload->>'hours')::numeric;
    if hrs is null or hrs <= 0 or hrs > 24 then raise exception 'Hours must be between 0 and 24'; end if;
    d := jsonb_set(d, '{log}', coalesce(d->'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'worker', left(coalesce(payload->>'worker', 'Crew'), 60), 'date', left(coalesce(payload->>'date', ''), 20),
      'hours', hrs, 'wid', wid)));
    if st < 1 then d := jsonb_set(d, '{status}', '1'::jsonb); end if;

  elsif kind = 'receipt' then
    amt := (payload->>'amount')::numeric;
    if amt is null or coalesce(trim(payload->>'label'), '') = '' then raise exception 'Receipt needs a label and an amount'; end if;
    d := jsonb_set(d, '{expenses}', (d->'expenses') || jsonb_build_array(jsonb_build_object(
      'label', left(payload->>'label', 200), 'amount', amt)));
    f := payload->'file';
    if jsonb_typeof(f) = 'object' and f->>'path' like jid || '/extra/%' then
      d := jsonb_set(d, '{files}', coalesce(d->'files', '[]'::jsonb) || jsonb_build_array(f || '{"kind":"extra"}'::jsonb));
    end if;

  elsif kind = 'files' then
    for f in select * from jsonb_array_elements(coalesce(payload->'files', '[]'::jsonb)) loop
      if f->>'path' like jid || '/media/%' or f->>'path' like jid || '/extra/%' then
        d := jsonb_set(d, '{files}', coalesce(d->'files', '[]'::jsonb) || jsonb_build_array(f));
      end if;
    end loop;

  else
    raise exception 'Unknown action';
  end if;

  update jobs set data = d, by = null, updated_at = now() where id = jid;
end $$;

revoke all on function public.claim_profile() from anon;
revoke all on function public.crew_snapshot() from anon;
revoke all on function public.worker_job_update(text, text, jsonb) from anon;

-- ---------------------------------------------------------------- job photos and files
insert into storage.buckets (id, name, public) values ('job-files', 'job-files', false)
  on conflict (id) do nothing;

drop policy if exists "crm office files" on storage.objects;
create policy "crm office files" on storage.objects for all to authenticated
  using (bucket_id = 'job-files' and public.is_office())
  with check (bucket_id = 'job-files' and public.is_office());

-- Painters: only the photo/video and "added later" folders of their own crew's jobs.
drop policy if exists "crm crew files read" on storage.objects;
create policy "crm crew files read" on storage.objects for select to authenticated
  using (bucket_id = 'job-files'
     and (storage.foldername(name))[2] in ('media', 'extra')
     and public.can_access_job((storage.foldername(name))[1]));

drop policy if exists "crm crew files add" on storage.objects;
create policy "crm crew files add" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files'
     and (storage.foldername(name))[2] in ('media', 'extra')
     and public.can_access_job((storage.foldername(name))[1]));

-- ---------------------------------------------------------------- live updates between office devices
do $$
declare t text;
begin
  foreach t in array array['staff','leads','jobs','workers','settings','clocks'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
