-- ============================================================================
-- SG-SST Control · Migración 0017: numeración de la Cuenta de cobro
-- ----------------------------------------------------------------------------
-- Reemplaza el "No. [PENDIENTE]" del encabezado de la Cuenta de cobro por un
-- número mnemotécnico: PROVEEDOR-EMPRESA-FECHA-CONSECUTIVO
-- (ej: AGUA-SINC-20260924-000).
--
-- Reglas acordadas:
--   - El consecutivo es GLOBAL: una sola numeración para todas las cuentas
--     de cobro, sin importar el proveedor o la empresa.
--   - Arranca en 0 desde que se corre esta migración y NUNCA se reinicia
--     (no vuelve a 0 cada día ni cada mes).
--   - El código de proveedor/empresa son las iniciales automáticas del
--     nombre (primeras letras).
--
-- Cada cuenta de cobro se identifica por proveedor + periodo facturado
-- (mes). Si vuelves a abrir o exportar la misma cuenta de cobro (mismo
-- proveedor, mismo mes), conserva el mismo número — no se genera uno nuevo
-- cada vez que la abres o la descargas de nuevo.
-- ============================================================================

create sequence if not exists public.invoice_number_seq as bigint minvalue 0 start with 0 increment by 1;

create table if not exists public.invoice_numbers (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references public.providers(id) on delete set null,
  period text not null,           -- 'YYYY-MM' del periodo facturado
  consecutive bigint not null,
  code text not null,
  created_at timestamptz not null default now(),
  unique (provider_id, period)
);

alter table public.invoice_numbers enable row level security;
create policy invoice_numbers_select on public.invoice_numbers for select using (auth.role() = 'authenticated');
create policy invoice_numbers_write on public.invoice_numbers for all using (public.current_user_role() in ('admin','consultor')) with check (public.current_user_role() in ('admin','consultor'));

-- Entrega siempre el mismo número para un proveedor+periodo ya facturado, y
-- solo saca uno nuevo del consecutivo global la primera vez que se genera.
create or replace function public.get_or_create_invoice_number(
  p_provider_id uuid, p_period text, p_code_prefix text
) returns text
language plpgsql
security definer
as $$
declare
  v_code text;
  v_next bigint;
begin
  select code into v_code from public.invoice_numbers
  where provider_id = p_provider_id and period = p_period;

  if v_code is not null then
    return v_code;
  end if;

  v_next := nextval('public.invoice_number_seq');
  v_code := p_code_prefix || '-' || lpad(v_next::text, 3, '0');

  insert into public.invoice_numbers (provider_id, period, consecutive, code)
  values (p_provider_id, p_period, v_next, v_code)
  on conflict (provider_id, period) do nothing;

  select code into v_code from public.invoice_numbers
  where provider_id = p_provider_id and period = p_period;

  return v_code;
end;
$$;

grant execute on function public.get_or_create_invoice_number(uuid, text, text) to authenticated;
