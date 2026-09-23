-- ============================================================================
-- SG-SST Control · Migración 0011: proveedores (organigrama Proveedor →
-- Empresa → Sedes → Actividades)
-- ----------------------------------------------------------------------------
-- Yasbleidis maneja empresas que llegan a través de distintos proveedores
-- (ej. ARL Positiva, OrientarSalud, Rehavid SAS). Se agrega una tabla nueva
-- "providers" y una columna opcional companies.provider_id, para poder
-- agrupar/filtrar empresas por el proveedor al que pertenecen.
--
-- 100% aditivo: no borra ni modifica nada existente. Las empresas que ya
-- están cargadas quedan con provider_id en null (sin proveedor asignado) —
-- Yasbleidis las va etiquetando ella misma desde Configuración → Empresas,
-- que ahora tiene una columna "Proveedor" siempre visible para eso.
-- ============================================================================

create table public.providers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
comment on table public.providers is
  'Proveedores (ej. ARL) a través de los cuales llegan empresas. Una empresa puede no tener proveedor asignado (cliente directo).';

alter table public.providers enable row level security;
create policy providers_select on public.providers for select using (auth.role() = 'authenticated');
create policy providers_write on public.providers for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));

alter table public.companies
  add column if not exists provider_id uuid references public.providers(id) on delete set null;
comment on column public.companies.provider_id is
  'Proveedor al que pertenece esta empresa (opcional — puede quedar sin proveedor para clientes directos). Se asigna/edita desde Configuración → Empresas.';

-- Proveedores iniciales pedidos por Yasbleidis. Las empresas que ya existen
-- NO se asignan automáticamente a ninguno de estos — eso lo hace ella misma
-- desde la interfaz.
insert into public.providers (name) values
  ('OrientarSalud'),
  ('Rehavid SAS'),
  ('ARL Positiva Compañía de Seguros')
on conflict (name) do nothing;
