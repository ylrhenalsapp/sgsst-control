-- ============================================================================
-- SG-SST Control · Migración 0003: Row Level Security
-- ----------------------------------------------------------------------------
-- Modelo de permisos simple (por diseño, evitando complejidad innecesaria):
--   admin     -> lee y escribe todo, incluida la eliminación de registros
--   consultor -> lee todo, puede crear/editar (horas, evidencias, agenda,
--                bolsas), no puede eliminar empresas/sedes ni borrar historial
--   lector    -> solo lectura (útil para un cliente o supervisor externo)
-- Todas las tablas exigen sesión autenticada (auth.uid() no nulo); no hay
-- acceso anónimo a datos operativos.
-- ============================================================================

alter table public.profiles               enable row level security;
alter table public.companies               enable row level security;
alter table public.sites                   enable row level security;
alter table public.activities              enable row level security;
alter table public.activity_targets        enable row level security;
alter table public.activity_status_history enable row level security;
alter table public.monthly_bags            enable row level security;
alter table public.bag_adjustments         enable row level security;
alter table public.hour_records            enable row level security;
alter table public.evidences               enable row level security;
alter table public.schedule_events         enable row level security;
alter table public.app_settings            enable row level security;

-- profiles: cada usuario ve/edita su propio perfil; admin ve todos
create policy profiles_select on public.profiles for select
  using (auth.uid() = id or public.current_user_role() = 'admin');
create policy profiles_update_self on public.profiles for update
  using (auth.uid() = id or public.current_user_role() = 'admin');
create policy profiles_insert_admin on public.profiles for insert
  with check (public.current_user_role() = 'admin' or auth.uid() = id);

-- Lectura general para cualquier usuario autenticado
create policy companies_select on public.companies for select using (auth.role() = 'authenticated');
create policy sites_select on public.sites for select using (auth.role() = 'authenticated');
create policy activities_select on public.activities for select using (auth.role() = 'authenticated');
create policy activity_targets_select on public.activity_targets for select using (auth.role() = 'authenticated');
create policy activity_history_select on public.activity_status_history for select using (auth.role() = 'authenticated');
create policy monthly_bags_select on public.monthly_bags for select using (auth.role() = 'authenticated');
create policy bag_adjustments_select on public.bag_adjustments for select using (auth.role() = 'authenticated');
create policy hour_records_select on public.hour_records for select using (auth.role() = 'authenticated');
create policy evidences_select on public.evidences for select using (auth.role() = 'authenticated');
create policy schedule_events_select on public.schedule_events for select using (auth.role() = 'authenticated');
create policy app_settings_select on public.app_settings for select using (auth.role() = 'authenticated');

-- Escritura: admin y consultor
create policy companies_write on public.companies for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy sites_write on public.sites for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy activities_write on public.activities for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy activity_targets_write on public.activity_targets for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy activity_history_write on public.activity_status_history for insert
  with check (public.current_user_role() in ('admin','consultor'));
create policy monthly_bags_write on public.monthly_bags for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy bag_adjustments_write on public.bag_adjustments for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy hour_records_write on public.hour_records for insert
  with check (public.current_user_role() in ('admin','consultor'));
create policy evidences_write on public.evidences for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
create policy schedule_events_write on public.schedule_events for all
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));

-- Solo admin puede borrar información histórica sensible o configuración
create policy hour_records_delete_admin on public.hour_records for delete
  using (public.current_user_role() = 'admin');
create policy app_settings_write_admin on public.app_settings for all
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
