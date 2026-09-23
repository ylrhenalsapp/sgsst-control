-- ============================================================================
-- SG-SST Control · Migración 0012: cuenta de cobro (datos de facturación del
-- proveedor, datos fijos de Yasbleidis, y registro de viáticos/desplazamiento)
-- ----------------------------------------------------------------------------
-- Complementa la migración 0011 (proveedores): agrega los datos que hacían
-- falta para poder generar automáticamente la "Cuenta de cobro" mensual que
-- Yasbleidis le presenta a cada proveedor (antes la armaba a mano en Excel).
--
-- 100% aditivo: no borra ni modifica nada existente.
-- ============================================================================

-- 1) Datos de facturación del proveedor (para el encabezado de la cuenta de
--    cobro: a quién se le está cobrando). Todos opcionales — se completan
--    desde Configuración → Proveedores cuando haga falta.
alter table public.providers
  add column if not exists nit text,
  add column if not exists gerente text,
  add column if not exists direccion text,
  add column if not exists ciudad text,
  add column if not exists telefono text,
  add column if not exists email_radicacion text;

-- 2) Datos fijos de Yasbleidis como contratista (los mismos en cualquier
--    cuenta de cobro, sin importar el proveedor). Tabla de una sola fila,
--    forzada con id boolean primary key default true.
create table public.advisor_profile (
  id                   boolean primary key default true,
  cedula               text,
  profesion            text,
  registro_profesional text,
  direccion            text,
  ciudad               text,
  departamento         text,
  telefono             text,
  celular              text,
  email                text,
  banco                text,
  cuenta_bancaria      text,
  regimen_iva          text default 'IVA Régimen Simplificado',
  actividad_economica  text,
  updated_at           timestamptz not null default now(),
  constraint advisor_profile_singleton check (id)
);
comment on table public.advisor_profile is
  'Datos fijos de Yasbleidis (cédula, profesión, cuenta bancaria, etc.) usados para llenar el encabezado de cada cuenta de cobro. Una sola fila.';

alter table public.advisor_profile enable row level security;
create policy advisor_profile_select on public.advisor_profile for select using (auth.role() = 'authenticated');
create policy advisor_profile_write on public.advisor_profile for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));

-- 3) Registro de viáticos / gastos de desplazamiento y representación, ligado
--    a empresa y sede igual que hour_records, para que se agrupen solos por
--    proveedor (vía companies.provider_id) al generar la cuenta de cobro. Un
--    solo valor por registro (no cantidad × valor unitario): un mismo gasto
--    puede juntar transporte, alimentación, etc. en un solo concepto.
create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  record_date date not null,
  concept     text not null,
  amount      numeric not null default 0,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
comment on table public.expenses is
  'Viáticos y gastos de desplazamiento/representación por empresa y sede, usados en la sección 2 de la Cuenta de cobro.';

alter table public.expenses enable row level security;
create policy expenses_select on public.expenses for select using (auth.role() = 'authenticated');
create policy expenses_write on public.expenses for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
