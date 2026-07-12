-- =========================================================================
-- KMRL FLEET-CTRL — SUPABASE SCHEMA
-- Run this whole file once in Supabase Dashboard -> SQL Editor -> New query
-- -> Run. Safe to re-run: it drops and recreates these 3 tables, so ALL
-- existing data in them is wiped ("reset to zero") every time you run it.
-- =========================================================================

drop table if exists public.complaints cascade;
drop table if exists public.trains cascade;
drop table if exists public.app_users cascade;

-- -------------------------------------------------------------------------
-- 1. LOGIN — username / password / role
-- -------------------------------------------------------------------------
create table public.app_users (
  id           uuid primary key default gen_random_uuid(),
  username     text unique not null,
  password     text not null,      -- demo only: plaintext. See note at bottom.
  name         text not null,
  role         text not null check (role in ('HOD', 'OPERATOR')),
  created_at   timestamptz not null default now()
);

-- =========================================================================
-- RESTRICTED ACCESS — ONLY these 21 accounts exist. No public/demo/self
-- sign-up accounts. 1 HOD + 20 Technicians (OPERATOR role).
-- =========================================================================
insert into public.app_users (username, password, name, role) values
  ('kathir', 'kathir01', 'Kathir (HOD)', 'HOD'),

  ('tech01', 'Metro125!',   'Arun Kumar',      'OPERATOR'),
  ('tech02', 'Aluva328#',   'Bipin Das',       'OPERATOR'),
  ('tech03', 'Metro792@',   'Cibi Chandran',   'OPERATOR'),
  ('tech04', 'Transit532@', 'Deepak Nair',     'OPERATOR'),
  ('tech05', 'Rail195#',    'Elango R',        'OPERATOR'),
  ('tech06', 'Aluva617@',   'Farook Ali',      'OPERATOR'),
  ('tech07', 'Bogie303$',   'Gokul Krishna',   'OPERATOR'),
  ('tech08', 'Aluva559!',   'Hari Krishnan',   'OPERATOR'),
  ('tech09', 'Rail877#',    'Ijas Rahman',     'OPERATOR'),
  ('tech10', 'Coach448!',   'Jithin P',        'OPERATOR'),
  ('tech11', 'Kochi320!',   'Kannan S',        'OPERATOR'),
  ('tech12', 'Metro194$',   'Lakshman V',      'OPERATOR'),
  ('tech13', 'Metro467!',   'Muthu Kumar',     'OPERATOR'),
  ('tech14', 'Transit370@', 'Naveen Raj',      'OPERATOR'),
  ('tech15', 'Depot649@',   'Om Prakash',      'OPERATOR'),
  ('tech16', 'Coach180!',   'Prasad K',        'OPERATOR'),
  ('tech17', 'Transit982!', 'Rajesh Menon',    'OPERATOR'),
  ('tech18', 'Transit296@', 'Sanjay Varma',    'OPERATOR'),
  ('tech19', 'Rail777#',    'Thomas Jacob',    'OPERATOR'),
  ('tech20', 'Track181#',   'Vishnu Nair',     'OPERATOR');

-- -------------------------------------------------------------------------
-- 2. TRAINS — one row per KMRL trainset. Seeded at ZERO baseline; the app
--    edits these live and writes changes back here as they happen.
-- -------------------------------------------------------------------------
create table public.trains (
  id                          text primary key,          -- e.g. KMRL-T01
  number                      int not null,
  name                        text not null,
  bay                         int not null,
  mileage_km                  int not null default 0,
  mileage_since_service       int not null default 0,
  mileage_rate_per_hour       int not null default 0,
  cert_days_left              int not null default 0,
  job_card_open               boolean not null default false,
  branding_hours_pending      int not null default 0,
  last_cleaned_days_ago       int not null default 0,
  checks_complete             boolean not null default false,
  approved                    boolean not null default false,
  traction_motor_health       int not null default 0,
  brake_pad_wear              int not null default 0,
  battery_health              int not null default 0,
  hvac_status                 text not null default 'Optimal',
  energy_consumption_kwh_km   numeric not null default 0,
  regen_braking_efficiency    int not null default 0,
  last_service_date           date,
  last_service_type           text,
  last_service_notes          text,
  last_service_approved_by    text,
  service_history             jsonb not null default '[]'::jsonb,
  assigned_operator           text,
  updated_at                  timestamptz not null default now()
);

-- Seed all 25 trainsets at zero baseline (bay = number, round-robin over 6 bays).
insert into public.trains (id, number, name, bay)
select
  'KMRL-T' || lpad(n::text, 2, '0'),
  n,
  name,
  ((n - 1) % 6) + 1
from unnest(array[
  'Krishna','Tapti','Nila','Sarayu','Aruth','Vaigai','Jhanavi','Dhwanil',
  'Bhavani','Padma','Mandakini','Yamuna','Periyar','Kabani','Vaayu',
  'Kaveri','Shiriya','Pampa','Narmada','Mahe','Maarut','Sabarmathi',
  'Godhavari','Ganga','Pavan'
]) with ordinality as t(name, n);

-- -------------------------------------------------------------------------
-- 3. PASSENGER QUERIES — logged by passengers scanning the in-train QR code.
--    Reviewed by HOD, who assigns an expected-completion date and pushes
--    it to Service.
-- -------------------------------------------------------------------------
create table public.complaints (
  id                       uuid primary key default gen_random_uuid(),
  train_id                 text not null references public.trains(id) on delete cascade,
  train_name               text not null,
  compartment              text not null,
  issue                    text not null,
  description              text,
  status                   text not null default 'OPEN'
                             check (status in ('OPEN', 'UNDER_REVIEW', 'SENT_TO_SERVICE', 'RESOLVED')),
  reviewed_by              text,               -- HOD who reviewed it
  expected_completion_date date,               -- HOD-assigned target date
  sent_to_service_at       timestamptz,
  resolved_by              text,
  resolved_ts              timestamptz,
  ts                       timestamptz not null default now()
);

create index complaints_status_idx on public.complaints (status);
create index complaints_train_idx on public.complaints (train_id);

-- -------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
--    Enabled with permissive "anon" policies so the demo frontend (which
--    talks to Supabase directly with the public anon key, no server) can
--    read/write. Fine for a hackathon demo; for a real deployment move the
--    login check and any writes behind a server-side function instead of
--    trusting the browser directly, and tighten these policies.
-- -------------------------------------------------------------------------
alter table public.app_users enable row level security;
alter table public.trains    enable row level security;
alter table public.complaints enable row level security;

create policy "anon can read app_users for login" on public.app_users
  for select using (true);

create policy "anon can read trains" on public.trains
  for select using (true);
create policy "anon can update trains" on public.trains
  for update using (true);
create policy "anon can insert trains" on public.trains
  for insert with check (true);

create policy "anon can read complaints" on public.complaints
  for select using (true);
create policy "anon can insert complaints" on public.complaints
  for insert with check (true);
create policy "anon can update complaints" on public.complaints
  for update using (true);

-- -------------------------------------------------------------------------
-- 5. REALTIME — lets the dashboard update instantly (no polling) when a
--    passenger submits a new query, or when HOD updates one.
-- -------------------------------------------------------------------------
alter publication supabase_realtime add table public.complaints;
alter publication supabase_realtime add table public.trains;

-- NOTE on passwords: app_users.password is plaintext here purely to keep
-- this hackathon build simple (no server to hash against). Do not reuse
-- real passwords. For anything beyond a demo, switch to Supabase Auth
-- (auth.users + email/password sign-in) instead of this custom table.
--
-- NOTE on access: this app now ships with a fixed, restricted account list
-- only — 1 HOD ("kathir") + 20 technicians ("tech01".."tech20"). There is
-- no sign-up flow anywhere in the app; the ONLY way in is one of these 21
-- rows in app_users. To rotate a password, run:
--   update public.app_users set password = 'NEW_PASSWORD' where username = 'tech01';
-- To add a technician, insert a new row with role = 'OPERATOR'.
