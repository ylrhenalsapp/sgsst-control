-- ============================================================================
-- SG-SST Control · Migración 0018: tarifa por hora a nivel de proveedor
-- ----------------------------------------------------------------------------
-- Hasta ahora la tarifa por hora vivía solo en companies.rate (una por
-- empresa). Como un proveedor puede cubrir varias empresas que cobran todas
-- lo mismo, esta migración agrega providers.rate: si la empresa tiene un
-- proveedor asignado y ese proveedor tiene tarifa cargada, la app usa esa
-- tarifa automáticamente para todas sus empresas (ya no hay que repetirla
-- una por una). Las empresas sin proveedor, o cuyo proveedor no tiene
-- tarifa propia, siguen usando companies.rate como antes.
--
-- 100% aditivo: no borra ni modifica companies.rate, y los registros de
-- horas ya guardados conservan la tarifa con la que se crearon (cada uno es
-- una "foto" fija, igual que hoy) — este cambio solo afecta la tarifa que
-- se PROPONE para registros nuevos.
-- ============================================================================

alter table public.providers
  add column if not exists rate numeric;
