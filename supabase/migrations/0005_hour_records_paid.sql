-- ============================================================================
-- SG-SST Control · Migración 0005: estado de pago por registro de horas
-- ----------------------------------------------------------------------------
-- Agrega un campo "paid" a hour_records para que el informe pueda mostrar,
-- además del valor ejecutado, el valor YA PAGADO y el valor que todavía se
-- le debe a Yasbleidis (registros ejecutados pero no pagados). Por defecto
-- todo registro nuevo queda como "pendiente de pago" (false).
-- ============================================================================

alter table public.hour_records
  add column if not exists paid boolean not null default false;

comment on column public.hour_records.paid is
  'true = ya se pagó ese registro de horas; false = valor pendiente de cobro.';

-- Antes solo existía política de INSERT para admin/consultor. Se agrega
-- UPDATE para poder marcar un registro como pagado/pendiente sin habilitar
-- edición del resto de campos por fuera de la aplicación (la RLS no puede
-- limitar columnas, pero el cliente solo actualiza "paid" desde la interfaz).
create policy hour_records_update_payment on public.hour_records for update
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
