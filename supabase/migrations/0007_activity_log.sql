-- ============================================================================
-- SG-SST Control · Migración 0007: bitácora de actividad
-- ----------------------------------------------------------------------------
-- Agrega una tabla de solo-registro (nadie edita ni borra desde la interfaz)
-- donde la aplicación va dejando constancia de las acciones relevantes:
--   - Creación de empresas y sedes
--   - Carga/asignación de actividades a una sede (o al catálogo)
--   - Registro y edición de horas
-- Se muestra como un feed de "Actividad reciente" en el Dashboard. Es 100%
-- aditivo: no toca ninguna tabla ni dato existente.
-- ============================================================================

create table public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id),
  action_type text not null, -- 'company_created' | 'site_created' | 'activities_loaded' | 'hours_registered'
  description text not null, -- texto ya armado y listo para mostrar, ej: 'Se registraron 7 h en "X" (Sede Y).'
  company_id  uuid references public.companies(id) on delete set null,
  site_id     uuid references public.sites(id) on delete set null
);
comment on table public.activity_log is
  'Bitácora de acciones relevantes (empresas/sedes creadas, actividades cargadas, horas registradas) para el feed de "Actividad reciente" del Dashboard. Solo se inserta, nunca se edita ni se borra desde la aplicación.';

alter table public.activity_log enable row level security;

-- Cualquier usuario autenticado puede ver la bitácora completa (no es
-- información sensible por sede/empresa, es un histórico general de uso).
create policy activity_log_select on public.activity_log for select
  using (auth.role() = 'authenticated');

-- Solo admin/consultor pueden agregar entradas (mismos roles que ya pueden
-- crear empresas, sedes, actividades y horas en el resto de la app).
create policy activity_log_insert on public.activity_log for insert
  with check (public.current_user_role() in ('admin','consultor'));

-- Intencionalmente NO hay política de update ni delete: la bitácora es de
-- solo lectura una vez escrita, para que sirva como histórico confiable.

create index activity_log_created_at_idx on public.activity_log (created_at desc);
