-- ============================================================================
-- SG-SST Control · Migración 0016: licencia SST + datos reales de Yasbleidis
-- ----------------------------------------------------------------------------
-- 1) Agrega a "Mis datos" (public.advisor_profile) un campo para la licencia
--    de prestación de servicios en SST, distinta del registro profesional
--    (TP) que ya existía — son dos credenciales distintas para un
--    fisioterapeuta que presta servicios de Seguridad y Salud en el Trabajo.
-- 2) Carga de una vez los datos reales de Yasbleidis (la titular, una sola
--    persona) para que aparezcan ya completos en Configuración → Mis datos,
--    sin tener que volver a digitarlos.
--
-- 100% aditivo y seguro de correr más de una vez: el upsert usa el mismo id
-- fijo (true) de la fila única de advisor_profile.
-- ============================================================================

alter table public.advisor_profile
  add column if not exists licencia_sst text;

insert into public.advisor_profile (
  id, cedula, profesion, registro_profesional, licencia_sst,
  ciudad, departamento, celular, banco, cuenta_bancaria,
  email, actividad_economica
) values (
  true, '1067886254', 'Fisioterapeuta Esp. SST', 'TP 2380715', '30011123/2024',
  'Montería', 'Córdoba', '3023654997', 'Bancolombia (Ahorros)', '16600007542',
  'Ylrhenals@gmail.com', '7490'
)
on conflict (id) do update set
  cedula               = excluded.cedula,
  profesion            = excluded.profesion,
  registro_profesional = excluded.registro_profesional,
  licencia_sst         = excluded.licencia_sst,
  ciudad               = excluded.ciudad,
  departamento         = excluded.departamento,
  celular              = excluded.celular,
  banco                = excluded.banco,
  cuenta_bancaria      = excluded.cuenta_bancaria,
  email                = excluded.email,
  actividad_economica  = excluded.actividad_economica;
