-- ============================================================================
-- SG-SST Control · Migración 0006: actividades por sede + cierre mensual
-- ----------------------------------------------------------------------------
-- Agrega dos cosas nuevas que pidió Yasbleidis:
--   1. site_activities: qué actividades del catálogo global aplican a cada
--      sede en concreto (antes TODAS las sedes veían TODAS las actividades).
--      Se define en el wizard "Agregar empresa/sede" o desde Configuración.
--   2. month_closures: cierre manual de mes por sede. Mientras el mes no se
--      cierre, las horas se pueden seguir editando; una vez cerrado, no se
--      pueden agregar ni editar horas de ese mes (se puede reabrir si hace
--      falta corregir algo).
-- Es 100% aditivo: no borra ni modifica datos existentes. Las sedes que ya
-- existen conservan automáticamente TODAS las actividades actuales (nada
-- desaparece de golpe al aplicar esta migración).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ACTIVIDADES POR SEDE
-- ----------------------------------------------------------------------------
create table public.site_activities (
  site_id     uuid not null references public.sites(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  primary key (site_id, activity_id)
);
comment on table public.site_activities is
  'Actividades del catálogo global asignadas a cada sede en concreto (wizard de creación o Configuración → Actividades).';

alter table public.site_activities enable row level security;
create policy site_activities_select on public.site_activities for select using (auth.role() = 'authenticated');
create policy site_activities_write on public.site_activities for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));

-- Backfill: las sedes que YA existen conservan todas las actividades que ya
-- tenían disponibles (para no perder ni ocultar nada de lo que ya está
-- cargado). Desde ahora en adelante, las sedes NUEVAS solo ven las
-- actividades que se les asignen explícitamente.
insert into public.site_activities (site_id, activity_id)
select s.id, a.id from public.sites s cross join public.activities a
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. CIERRE MENSUAL MANUAL POR SEDE
-- ----------------------------------------------------------------------------
create table public.month_closures (
  site_id     uuid not null references public.sites(id) on delete cascade,
  month       date not null, -- siempre día 1 del mes
  closed_by   uuid references public.profiles(id),
  closed_at   timestamptz not null default now(),
  reopened_by uuid references public.profiles(id),
  reopened_at timestamptz,
  primary key (site_id, month),
  check (extract(day from month) = 1)
);
comment on table public.month_closures is
  'Cierre manual de mes por sede. Sin fila (o con reopened_at) = mes abierto: se pueden agregar/editar horas. Con fila y reopened_at nulo = mes cerrado.';

alter table public.month_closures enable row level security;
create policy month_closures_select on public.month_closures for select using (auth.role() = 'authenticated');
create policy month_closures_write on public.month_closures for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));

-- Helper: ¿está cerrado el mes de esa sede?
create or replace function public.is_month_closed(p_site_id uuid, p_month date)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.month_closures
    where site_id = p_site_id
      and month = date_trunc('month', p_month)::date
      and reopened_at is null
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. EDICIÓN DE HORAS, BLOQUEADA SI EL MES YA ESTÁ CERRADO
-- Antes NO existía política de UPDATE para hour_records (solo INSERT), así
-- que editar una hora ya cargada era imposible para cualquier usuario. Ahora
-- se permite, pero ni insertar ni editar horas de un mes ya cerrado.
-- ----------------------------------------------------------------------------
drop policy if exists hour_records_write on public.hour_records;

create policy hour_records_insert on public.hour_records for insert
  with check (
    public.current_user_role() in ('admin','consultor')
    and not public.is_month_closed(site_id, record_date)
  );

create policy hour_records_update on public.hour_records for update
  using (
    public.current_user_role() in ('admin','consultor')
    and not public.is_month_closed(site_id, record_date)
  )
  with check (
    public.current_user_role() in ('admin','consultor')
    and not public.is_month_closed(site_id, record_date)
  );
