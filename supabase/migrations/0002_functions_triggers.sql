-- ============================================================================
-- SG-SST Control · Migración 0002: reglas de negocio en base de datos
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Regla dura: si la actividad (en esa sede) ya está "Completada", no se
-- puede insertar un nuevo registro de horas. Esto es EXACTAMENTE lo que el
-- prototipo ya hacía en app.js (taskIsCompleted) pero ahora se aplica a
-- nivel de base de datos, no solo en el navegador.
-- ----------------------------------------------------------------------------
create or replace function public.fn_block_hours_if_completed()
returns trigger
language plpgsql
security definer
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.v_activity_current_status
  where site_id = new.site_id and activity_id = new.activity_id;

  if v_status = 'Completada' then
    raise exception 'La actividad ya está completada y no admite más registros de horas.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_block_hours_on_completed
before insert on public.hour_records
for each row execute function public.fn_block_hours_if_completed();

-- ----------------------------------------------------------------------------
-- Cuando se guarda un registro de horas con status = 'Completado', se
-- refleja automáticamente en el historial de estado de la actividad
-- (equivalente a lo que hacía saveHours()/saveActivity() en el prototipo).
-- ----------------------------------------------------------------------------
create or replace function public.fn_hours_sync_activity_status()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.status = 'Completado' then
    insert into public.activity_status_history(site_id, activity_id, status, notes, changed_by)
    values (new.site_id, new.activity_id, 'Completada', new.notes, new.created_by);
  else
    -- si no existe historial previo para esa sede/actividad, arranca en "En proceso"
    if not exists (
      select 1 from public.activity_status_history
      where site_id = new.site_id and activity_id = new.activity_id
    ) then
      insert into public.activity_status_history(site_id, activity_id, status, notes, changed_by)
      values (new.site_id, new.activity_id, 'En proceso', new.notes, new.created_by);
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_hours_sync_activity_status
after insert on public.hour_records
for each row execute function public.fn_hours_sync_activity_status();

-- ----------------------------------------------------------------------------
-- Resumen de bolsa mensual con arrastre recursivo del mes anterior.
-- Traduce 1:1 la lógica que ya existía en JS (monthAssigned/monthAdditional/
-- monthCarryover/monthUsed/monthRemaining) a una función de Postgres, para
-- que el front-end (o un reporte) pueda pedir el resumen de cualquier mes
-- con una sola llamada: select * from get_bag_summary(site_id, '2026-08-01');
-- ----------------------------------------------------------------------------
create or replace function public.get_bag_summary(p_site_id uuid, p_month date)
returns table(assigned numeric, additional numeric, carry numeric, total numeric, used numeric, remaining numeric)
language plpgsql
stable
as $$
declare
  v_month     date := date_trunc('month', p_month)::date;
  v_prev      date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_bag_id    uuid;
  v_assigned  numeric := 0;
  v_additional numeric := 0;
  v_carry     numeric := 0;
  v_used      numeric := 0;
begin
  select id, assigned_hours into v_bag_id, v_assigned
  from public.monthly_bags
  where site_id = p_site_id and month = v_month;

  v_assigned := coalesce(v_assigned, 0);

  if v_bag_id is not null then
    select coalesce(sum(hours), 0) into v_additional
    from public.bag_adjustments where monthly_bag_id = v_bag_id;
  end if;

  if exists (select 1 from public.monthly_bags where site_id = p_site_id and month = v_prev) then
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
$$;

-- ----------------------------------------------------------------------------
-- Progreso REAL de una actividad en una sede: solo horas acumuladas y, si
-- existe una meta en activity_targets, el porcentaje real horas/meta.
-- Si no hay meta definida, percent siempre es NULL (nunca se inventa un %).
-- ----------------------------------------------------------------------------
create or replace function public.get_activity_progress(p_site_id uuid, p_activity_id uuid)
returns table(hours_accumulated numeric, target_hours numeric, percent numeric, status text)
language sql
stable
as $$
  select
    coalesce((select sum(hr.hours) from public.hour_records hr
              where hr.site_id = p_site_id and hr.activity_id = p_activity_id), 0) as hours_accumulated,
    t.target_hours,
    case when t.target_hours is not null and t.target_hours > 0
         then least(100, round(
                100 * coalesce((select sum(hr.hours) from public.hour_records hr
                                where hr.site_id = p_site_id and hr.activity_id = p_activity_id), 0)
                / t.target_hours, 1))
         else null end as percent,
    coalesce((select status from public.v_activity_current_status v
              where v.site_id = p_site_id and v.activity_id = p_activity_id), 'Pendiente') as status
  from (select p_site_id, p_activity_id) x
  left join public.activity_targets t on t.site_id = p_site_id and t.activity_id = p_activity_id;
$$;

-- ----------------------------------------------------------------------------
-- Helper de rol para políticas RLS
-- ----------------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
as $$
  select role from public.profiles where id = auth.uid();
$$;
