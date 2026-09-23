-- ============================================================================
-- SG-SST Control · Migración 0013: ajustar expenses a un solo valor (amount)
-- ----------------------------------------------------------------------------
-- Corrige la migración 0012: la tabla public.expenses se había creado con
-- quantity + unit_value; la app ahora usa un solo campo "amount" por registro
-- (un mismo gasto puede juntar transporte, alimentación, etc. como un solo
-- concepto). Esta migración AJUSTA la tabla que ya existe en tu base de datos
-- (porque ya corriste la versión anterior de 0012) — no la vuelve a crear.
--
-- Es segura de correr aunque la tabla ya tenga registros cargados: primero
-- traslada quantity × unit_value a "amount", y solo después borra esas dos
-- columnas. No se pierde información.
-- ============================================================================

-- 1) Agrega la columna nueva (si no existe todavía)
alter table public.expenses
  add column if not exists amount numeric not null default 0;

-- 2) Si existían quantity/unit_value, traslada su valor a "amount" antes de
--    borrarlas (quantity × unit_value = valor total de ese gasto)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'quantity'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'expenses' and column_name = 'unit_value'
  ) then
    update public.expenses
    set amount = coalesce(quantity, 0) * coalesce(unit_value, 0)
    where amount = 0;
  end if;
end $$;

-- 3) Elimina las columnas que ya no se usan (si existen)
alter table public.expenses
  drop column if exists quantity,
  drop column if exists unit_value;
