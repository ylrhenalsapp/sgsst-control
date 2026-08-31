-- ============================================================================
-- SG-SST Control · Migración 0008: tarifa por empresa (no global)
-- ----------------------------------------------------------------------------
-- Hasta ahora había UNA sola tarifa por hora para todo el sistema
-- (app_settings.default_rate). Yasbleidis pidió manejar tarifas distintas
-- SEGÚN LA EMPRESA (no por sede): cada empresa es la unidad principal para
-- este dato. Se agrega la columna companies.rate y se rellena con el valor
-- de la tarifa global anterior, para que ninguna empresa quede en $0 de un
-- día para otro. De ahora en adelante se edita empresa por empresa desde
-- Configuración → Tarifas.
--
-- Es 100% aditivo y no afecta el histórico: cada registro de horas ya
-- guardado (hour_records) conserva su propia tarifa tal como se guardó en su
-- momento — este cambio solo afecta qué tarifa se PROPONE para los registros
-- NUEVOS de cada empresa.
-- ============================================================================

alter table public.companies add column if not exists rate numeric not null default 50000;
comment on column public.companies.rate is
  'Tarifa por hora de ESTA empresa (COP). Reemplaza la antigua tarifa global única — cada empresa tiene la suya, y se propone automáticamente al registrar horas nuevas de esa empresa. No afecta registros ya guardados.';

-- Backfill: usar la tarifa global anterior como valor inicial para las
-- empresas que ya existen (si por algún motivo no se puede leer/convertir,
-- se deja el default de 50000 recién declarado arriba).
do $$
declare v_rate numeric;
begin
  begin
    select (value)::numeric into v_rate from public.app_settings where key = 'default_rate';
  exception when others then
    v_rate := null;
  end;
  if v_rate is not null then
    update public.companies set rate = v_rate;
  end if;
end $$;

-- Puede que nunca haya existido una política de UPDATE explícita para
-- companies (antes solo se insertaba/eliminaba desde la app, nunca se
-- editaba un campo). Se agrega una para admin/consultor, igual que en el
-- resto de tablas — si ya existía otra política de UPDATE equivalente, esto
-- no genera conflicto (las políticas RLS del mismo tipo se combinan con OR).
create policy companies_update on public.companies for update
  using (public.current_user_role() in ('admin','consultor'))
  with check (public.current_user_role() in ('admin','consultor'));
