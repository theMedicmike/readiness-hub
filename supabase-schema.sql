-- Operation Whole Health · Readiness Hub — Supabase schema (DRAFT v0.1)
-- Run this once in your Supabase project's SQL Editor after project creation,
-- THEN run supabase-seed-quiz-answers.sql (generated alongside this file).
-- Stores ONLY learning-platform activity (course progress, quiz scores, followed public
-- clinical-trial listings). No health/clinical data, no PHI — safe outside a HIPAA/BAA gate.
--
-- SECURITY NOTE (from adversarial review, 2026-07-08): quiz grading happens server-side
-- via submit_module_result() below, checked against a private answer-key table the client
-- can never read or write directly. This stops a logged-in user from forging a "passed"
-- record with a single raw API call. It does NOT stop someone from reading the correct
-- answers out of the module page's own HTML (shipped for good instant-feedback UX) and
-- then honestly selecting them — that's an open-book-test level of integrity, appropriate
-- for a free public v0.1 educational course, not a proctored exam. Flagging this tradeoff
-- explicitly rather than overclaiming the fix.

-- ============================================================
-- profiles: one row per authenticated user
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) <= 200),
  email text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- no delete policy: profile deletion happens via auth.users cascade only, never directly

-- profiles.email is always overwritten from the verified auth identity, never trusted
-- from client input — closes the "set my email to someone else's" spoof.
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.email := (select email from auth.users where id = new.id);
  return new;
end;
$$;

drop trigger if exists profiles_sync_email on public.profiles;
create trigger profiles_sync_email
  before insert or update on public.profiles
  for each row execute function public.sync_profile_email();

-- ============================================================
-- quiz_answer_keys: PRIVATE. RLS enabled with zero policies = unreachable via the
-- client API (anon/authenticated). Only readable from inside submit_module_result()
-- below, which runs as the table owner (security definer) and so bypasses RLS.
-- ============================================================
create table if not exists public.quiz_answer_keys (
  course text not null check (course in ('patient','caregiver','provider')),
  module_id text not null,
  question_index int not null check (question_index >= 0),
  correct_answer int not null check (correct_answer >= 0),
  primary key (course, module_id, question_index)
);

alter table public.quiz_answer_keys enable row level security;
-- intentionally no policies — deny-all to anon/authenticated by design

-- ============================================================
-- module_progress: quiz pass/fail + scores, one row per (user, course, module).
-- No INSERT or UPDATE policy for the authenticated role — the only legitimate way
-- to create/update a row is through submit_module_result() (security definer),
-- which independently grades against quiz_answer_keys rather than trusting the client.
-- ============================================================
create table if not exists public.module_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course text not null check (course in ('patient','caregiver','provider')),
  module_id text not null,
  passed boolean not null default false,
  best_score int not null default 0 check (best_score between 0 and 100),
  last_score int not null default 0 check (last_score between 0 and 100),
  attempts int not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default now(),
  unique (user_id, course, module_id)
);

alter table public.module_progress enable row level security;

create policy "module_progress_select_own" on public.module_progress
  for select using (auth.uid() = user_id);
create policy "module_progress_delete_own" on public.module_progress
  for delete using (auth.uid() = user_id);
-- no insert/update policy on purpose — see submit_module_result() below

-- Grades p_answers (a JSON array of 0-based selected option indexes, one per question,
-- in question order) against the private answer key, then upserts the AUTHORITATIVE
-- server-computed result. Returns the score so the UI can display it.
create or replace function public.submit_module_result(p_course text, p_module_id text, p_answers jsonb)
returns table(score int, passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
  v_correct int := 0;
  v_score int;
  v_passed boolean;
  v_key record;
  v_submitted int;
begin
  if p_course not in ('patient','caregiver','provider') then
    raise exception 'invalid course: %', p_course;
  end if;

  select count(*) into v_total from public.quiz_answer_keys
    where course = p_course and module_id = p_module_id;

  if v_total = 0 then
    raise exception 'no answer key found for %/%', p_course, p_module_id;
  end if;

  for v_key in
    select question_index, correct_answer from public.quiz_answer_keys
    where course = p_course and module_id = p_module_id
    order by question_index
  loop
    v_submitted := nullif(p_answers ->> v_key.question_index, '')::int;
    if v_submitted = v_key.correct_answer then
      v_correct := v_correct + 1;
    end if;
  end loop;

  v_score := round((v_correct::numeric / v_total) * 100);
  v_passed := v_score >= 75;

  insert into public.module_progress (user_id, course, module_id, passed, best_score, last_score, attempts, updated_at)
  values (auth.uid(), p_course, p_module_id, v_passed, v_score, v_score, 1, now())
  on conflict (user_id, course, module_id) do update
    set passed = public.module_progress.passed or excluded.passed,
        best_score = greatest(public.module_progress.best_score, excluded.best_score),
        last_score = excluded.last_score,
        attempts = public.module_progress.attempts + 1,
        updated_at = now();

  return query select v_score, v_passed;
end;
$$;

revoke all on function public.submit_module_result(text, text, jsonb) from public;
grant execute on function public.submit_module_result(text, text, jsonb) to authenticated;

-- ============================================================
-- followed_studies: clinical trials (public ClinicalTrials.gov listings) a user is tracking
-- ============================================================
create table if not exists public.followed_studies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nct_id text not null check (nct_id ~ '^NCT[0-9]{8}$'),
  title text check (title is null or char_length(title) <= 500),
  url text check (url is null or char_length(url) <= 2048),
  condition_label text check (condition_label is null or char_length(condition_label) <= 200),
  created_at timestamptz not null default now(),
  unique (user_id, nct_id)
);

alter table public.followed_studies enable row level security;

create policy "followed_studies_select_own" on public.followed_studies
  for select using (auth.uid() = user_id);
create policy "followed_studies_insert_own" on public.followed_studies
  for insert with check (auth.uid() = user_id);
create policy "followed_studies_delete_own" on public.followed_studies
  for delete using (auth.uid() = user_id);
-- no update policy: follow rows are create/delete only (unfollow + refollow), never edited in place

-- ============================================================
-- activity_log: recent-activity feed shown on the dashboard
-- ============================================================
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (char_length(type) <= 100),
  label text not null check (char_length(label) <= 500),
  created_at timestamptz not null default now()
);

alter table public.activity_log enable row level security;

create policy "activity_log_select_own" on public.activity_log
  for select using (auth.uid() = user_id);
create policy "activity_log_insert_own" on public.activity_log
  for insert with check (auth.uid() = user_id);
create policy "activity_log_delete_own" on public.activity_log
  for delete using (auth.uid() = user_id);

-- ============================================================
-- Helpful index for the dashboard's "recent activity" query (latest N per user)
-- ============================================================
create index if not exists activity_log_user_time_idx
  on public.activity_log (user_id, created_at desc);
