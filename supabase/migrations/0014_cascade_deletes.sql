-- ============================================================================
-- SG-SST Control · Migración 0014: permitir borrar una empresa de verdad
-- ----------------------------------------------------------------------------
-- Hoy, al intentar eliminar una empresa desde Configuración → Empresas, la
-- base de datos rechaza el borrado si esa empresa (o sus sedes) tienen horas,
-- evidencias o eventos de agenda registrados — porque esas tablas apuntan a
-- companies/sites SIN "on delete cascade". En la práctica, casi ninguna
-- empresa real se puede borrar hoy: la operación falla con un error crudo de
-- Postgres.
--
-- Esta migración ajusta esas 3 tablas (hour_records, evidences,
-- schedule_events) para que sí borren en cascada, igual que ya lo hacen
-- sites, monthly_bags, site_activities y expenses. Con esto, eliminar una
-- empresa elimina también, de una vez, todas sus sedes, horas, evidencias,
-- eventos de agenda, bolsas de horas y gastos — que es justamente lo que se
-- le advierte al usuario en la app antes de confirmar.
--
-- Es segura de correr las veces que haga falta: busca el nombre real de cada
-- restricción (constraint) antes de reemplazarla, en vez de asumirlo.
-- ============================================================================

do $$
declare
  rec record;
  cname text;
begin
  for rec in
    select * from (values
      ('hour_records',    'company_id', 'companies'),
      ('hour_records',    'site_id',    'sites'),
      ('evidences',       'company_id', 'companies'),
      ('evidences',       'site_id',    'sites'),
      ('schedule_events', 'company_id', 'companies'),
      ('schedule_events', 'site_id',    'sites')
    ) as t(tbl, col, reftbl)
  loop
    select tc.constraint_name into cname
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public' and tc.table_name = rec.tbl
      and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = rec.col;

    if cname is not null then
      execute format('alter table public.%I drop constraint %I', rec.tbl, cname);
    end if;

    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.%I(id) on delete cascade',
      rec.tbl, rec.tbl || '_' || rec.col || '_fkey', rec.col, rec.reftbl
    );
  end loop;
end $$;
