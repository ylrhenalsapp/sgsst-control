-- ============================================================================
-- SG-SST Control · Migración 0015: métodos de pago adicionales (Nequi, Bre-B)
-- ----------------------------------------------------------------------------
-- Complementa "Mis datos" (public.advisor_profile) con dos formas de pago que
-- Yasbleidis quiere ofrecer además de la cuenta bancaria tradicional:
--   - Nequi: número celular asociado a la cuenta Nequi.
--   - Llave Bre-B (Bancolombia): la llave del nuevo sistema interoperable de
--     transferencias inmediatas (puede ser un celular, cédula, correo o alias
--     personalizado registrado en Bre-B).
-- Ambas son opcionales y se muestran en la Cuenta de cobro junto a los demás
-- datos de pago. 100% aditivo: no borra ni modifica nada existente.
-- ============================================================================

alter table public.advisor_profile
  add column if not exists nequi text,
  add column if not exists llave_bre_b text;
