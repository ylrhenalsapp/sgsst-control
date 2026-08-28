-- ============================================================================
-- SG-SST Control · Migración 0001: esquema base
-- ----------------------------------------------------------------------------
-- Crea el modelo relacional completo que reemplaza el localStorage del
-- prototipo original (clave "sgsst_control_v1"). Pensado para Supabase
-- (Postgres + Auth + Storage), pero es SQL estándar y corre en cualquier
-- Postgres.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "btree_gist"; -- constraint EXCLUDE de agenda

-- ----------------------------------------------------------------------------
-- 1. PERFILES DE USUARIO
-- Extiende auth.users (Supabase Auth). No se guarda contraseña ni cédula
-- como mecanismo de acceso: la cédula queda solo como dato informativo,
-- igual que en la plataforma actual ("Ingresó: Yasbleidis López Rhenals").
-- ----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null,
  cedula        text,
  role          text not null default 'consultor'
                  check (role in ('admin','consultor','lector')),
  position_title text,
  created_at    timestamptz not null default now()
);
comment on table public.profiles is 'Usuarios de la plataforma. role controla permisos vía RLS.';

-- ----------------------------------------------------------------------------
-- 2. EMPRESAS Y SEDES
-- ----------------------------------------------------------------------------
create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

-- ----------------------------------------------------------------------------
-- 3. ACTIVIDADES (catálogo global: las 5 fijas + las que se agreguen)
-- ----------------------------------------------------------------------------
create table public.activities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  is_fixed   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Meta opcional de horas por (sede, actividad). Si no existe, la actividad
-- se mide SOLO por horas acumuladas (sin inventar un porcentaje).
create table public.activity_targets (
  site_id      uuid not null references public.sites(id) on delete cascade,
  activity_id  uuid not null references public.activities(id) on delete cascade,
  target_hours numeric(8,2) not null check (target_hours > 0),
  primary key (site_id, activity_id)
);
comment on table public.activity_targets is
  'Meta de horas opcional por sede/actividad. Si no hay fila, no se calcula %, solo horas acumuladas.';

-- Historial de estado por (sede, actividad) — append-only para trazabilidad
-- total. El estado "actual" es el último registro por changed_at.
create table public.activity_status_history (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  status      text not null check (status in ('Pendiente','En proceso','Completada')),
  notes       text,
  changed_by  uuid references public.profiles(id),
  changed_at  timestamptz not null default now()
);
create index idx_ash_site_activity on public.activity_status_history(site_id, activity_id, changed_at desc);

create view public.v_activity_current_status as
select distinct on (site_id, activity_id)
  site_id, activity_id, status, notes, changed_by, changed_at
from public.activity_status_history
order by site_id, activity_id, changed_at desc;

-- ----------------------------------------------------------------------------
-- 4. BOLSA DE HORAS MENSUAL (con arrastre / saldo a favor)
-- ----------------------------------------------------------------------------
create table public.monthly_bags (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references public.sites(id) on delete cascade,
  month          date not null, -- siempre día 1 del mes
  assigned_hours numeric(8,2) not null default 0 check (assigned_hours >= 0),
  assigned_date  date,
  reason         text,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  unique (site_id, month),
  check (extract(day from month) = 1)
);

create table public.bag_adjustments (
  id              uuid primary key default gen_random_uuid(),
  monthly_bag_id  uuid not null references public.monthly_bags(id) on delete cascade,
  hours           numeric(8,2) not null check (hours > 0),
  reason          text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now()
);
comment on table public.bag_adjustments is
  'Horas adicionales agregadas a la bolsa de un mes, con trazabilidad completa (quién, cuándo, por qué).';

-- ----------------------------------------------------------------------------
-- 5. REGISTRO DE HORAS EJECUTADAS
-- ----------------------------------------------------------------------------
create table public.hour_records (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  site_id      uuid not null references public.sites(id),
  activity_id  uuid not null references public.activities(id),
  record_date  date not null,
  hours        numeric(6,2) not null check (hours > 0),
  rate         numeric(12,2) not null check (rate >= 0), -- tarifa fija de ESTE registro
  status       text not null check (status in ('En proceso','Completado')),
  notes        text,
  source       text not null default 'manual',
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index idx_hour_records_site_month on public.hour_records(site_id, record_date);
create index idx_hour_records_activity on public.hour_records(activity_id);

-- ----------------------------------------------------------------------------
-- 6. EVIDENCIAS (archivo real en Supabase Storage, o link externo)
-- ----------------------------------------------------------------------------
create table public.evidences (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  site_id       uuid not null references public.sites(id),
  activity_id   uuid references public.activities(id),
  record_date   date not null,
  description   text,
  link          text,
  storage_path  text, -- ruta del objeto en el bucket 'evidencias'
  file_name     text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  check (link is not null or storage_path is not null)
);

-- ----------------------------------------------------------------------------
-- 7. AGENDA / PROGRAMACIÓN (con bloqueo real de cruces de horario)
-- ----------------------------------------------------------------------------
create table public.schedule_events (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies(id),
  site_id                uuid not null references public.sites(id),
  activity_id            uuid not null references public.activities(id),
  event_date             date not null,
  event_time             time not null,
  duration_minutes       int not null default 60 check (duration_minutes > 0),
  leader_name            text,
  leader_email           text,
  proposed_date          date,
  proposed_time          time,
  reminder_minutes       int default 30,
  notes                  text,
  google_calendar_synced boolean not null default false,
  created_by             uuid references public.profiles(id),
  created_at             timestamptz not null default now(),
  time_range             tsrange generated always as (
    tsrange(
      (event_date + event_time)::timestamp,
      (event_date + event_time)::timestamp + (duration_minutes * interval '1 minute')
    )
  ) stored,
  constraint schedule_events_no_overlap exclude using gist (site_id with =, time_range with &&)
);
comment on constraint schedule_events_no_overlap on public.schedule_events is
  'Impide guardar dos sesiones que se crucen en horario para la misma sede (conflicto de agenda) a nivel de base de datos.';

-- ----------------------------------------------------------------------------
-- 8. CONFIGURACIÓN GENERAL (tarifa por defecto, etc.)
-- ----------------------------------------------------------------------------
create table public.app_settings (
  key   text primary key,
  value jsonb not null
);
