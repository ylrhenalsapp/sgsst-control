-- ============================================================================
-- SG-SST Control · Migración 0009: reinicio del saldo anterior en septiembre
-- ----------------------------------------------------------------------------
-- Yasbleidis pidió que, a partir de septiembre 2026, el "Saldo anterior" de
-- la bolsa de horas de CADA sede (de cualquier empresa) arranque en cero, sin
-- arrastrar lo que haya quedado disponible en agosto o meses previos. Las
-- horas "Asignadas" que ya cargó para septiembre NO se tocan, y lo "Usado"
-- sigue saliendo de hour_records como siempre (los informes se actualizan
-- solos, no hace falta tocarlos).
--
-- El "Saldo anterior" no es un valor guardado en una tabla: lo calcula la
-- función get_bag_summary() de forma recursiva, tomando el "Disponible" del
-- mes anterior, el cual a su vez toma el del mes anterior a ese, y así hacia
-- atrás. Por eso la única forma correcta de reiniciarlo es modificar esa
-- función para que corte la cadena exactamente en septiembre 2026: ese mes
-- (y solo ese mes) fuerza el saldo anterior a 0; los meses posteriores
-- (octubre en adelante) siguen la cadena con normalidad a partir de ahí, y
-- los meses anteriores a septiembre (agosto y previos) quedan exactamente
-- igual que antes, por si se necesita consultar el histórico.
--
-- Probado localmente simulando 5 meses de historial con saldo acumulado
-- antes de aplicarse a producción: antes del cambio, septiembre arrastraba
-- el saldo de los 4 meses previos; después del cambio, septiembre queda en
-- 0 y octubre retoma la cadena normalmente desde el saldo real de septiembre.
-- ============================================================================

create or replace function public.get_bag_summary(p_site_id uuid, p_month date)
 returns table(assigned numeric, additional numeric, carry numeric, total numeric, used numeric, remaining numeric)
 language plpgsql
 stable
as $function$
declare
  v_month     date := date_trunc('month', p_month)::date;
  v_prev      date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_bag_id    uuid;
  v_assigned  numeric := 0;
  v_additional numeric := 0;
  v_carry     numeric := 0;
  v_used      numeric := 0;
  -- Punto de corte: desde este mes, el saldo anterior arranca en 0 para
  -- todas las sedes de todas las empresas. Si en el futuro se necesita otro
  -- reinicio, basta con actualizar esta fecha en una nueva migración.
  v_carry_reset_month constant date := '2026-09-01';
begin
  select id, assigned_hours into v_bag_id, v_assigned
  from public.monthly_bags
  where site_id = p_site_id and month = v_month;

  v_assigned := coalesce(v_assigned, 0);

  if v_bag_id is not null then
    select coalesce(sum(hours), 0) into v_additional
    from public.bag_adjustments where monthly_bag_id = v_bag_id;
  end if;

  if v_month = v_carry_reset_month then
    v_carry := 0;
  elsif exists (select 1 from public.monthly_bags where site_id = p_site_id and month = v_prev) then
    select r.remaining into v_carry from public.get_bag_summary(p_site_id, v_prev) r;
  end if;
  v_carry := coalesce(v_carry, 0);

  select coalesce(sum(hours), 0) into v_used
  from public.hour_records
  where site_id = p_site_id
    and date_trunc('month', record_date)::date = v_month;

  return query select
    v_assigned,
    v_additional,
    v_carry,
    v_assigned + v_additional + v_carry,
    v_used,
    greatest(0, v_assigned + v_additional + v_carry - v_used);
end;
$function$;
