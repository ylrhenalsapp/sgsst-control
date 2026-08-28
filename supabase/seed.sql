-- ============================================================================
-- SG-SST Control · Datos semilla
-- ----------------------------------------------------------------------------
-- Contiene: las 2 empresas y 3 sedes del proyecto actual, las 5 actividades
-- fijas, y la tarifa por defecto. NO crea el usuario Yasbleidis (eso requiere
-- Supabase Auth, no SQL puro) — para eso usa scripts/seed-admin-user.mjs,
-- descrito en el README.
-- ============================================================================

insert into public.companies (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'VEOLIA AGUAS DE MONTERÍA S.A. E.S.P.'),
  ('22222222-2222-2222-2222-222222222222', 'AGUAS DE LA SABANA S.A. E.S.P.')
on conflict (name) do nothing;

insert into public.sites (id, company_id, name) values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Montería'),
  ('a2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Corozal'),
  ('a3333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'Sincelejo')
on conflict (company_id, name) do nothing;

insert into public.activities (id, name, is_fixed) values
  ('b1111111-1111-1111-1111-111111111111', 'Aplicación del estado de madurez del SVE.', true),
  ('b2222222-2222-2222-2222-222222222222', 'Seguimiento a la matriz de mejoras.', true),
  ('b3333333-3333-3333-3333-333333333333', 'Capacitación de estándares desarrollados hasta el momento.', true),
  ('b4444444-4444-4444-4444-444444444444', 'Verificación y análisis de carga física.', true),
  ('b5555555-5555-5555-5555-555555555555', 'Verificación de cambios en herramientas recomendadas.', true)
on conflict do nothing;

insert into public.app_settings (key, value) values
  ('default_rate', '50000')
on conflict (key) do nothing;

-- Bolsa inicial del mes en curso para Montería (70 h), igual que el
-- prototipo original. Ajusta el mes/las horas de Corozal y Sincelejo
-- cuando el cliente confirme las horas asignadas a esas sedes.
insert into public.monthly_bags (site_id, month, assigned_hours, assigned_date, reason)
values (
  'a1111111-1111-1111-1111-111111111111',
  date_trunc('month', current_date)::date,
  70,
  current_date,
  'Bolsa inicial migrada desde la plataforma anterior.'
)
on conflict (site_id, month) do nothing;
