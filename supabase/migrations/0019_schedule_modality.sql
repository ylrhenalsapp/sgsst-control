-- ============================================================================
-- SG-SST Control · Migración 0019: modalidad (presencial/virtual) + Google
-- Calendar/Meet en schedule_events
-- ----------------------------------------------------------------------------
-- Hasta ahora toda sesión programada en la Agenda se asumía presencial. Esta
-- migración agrega:
--   modality         'presencial' o 'virtual' — elegido al programar la
--                     sesión (por defecto 'presencial', así que las filas ya
--                     existentes quedan como estaban).
--   meet_link        el link real de Google Meet que Google genera solo
--                     cuando la sesión es virtual y se envía la citación
--                     (queda vacío para las presenciales).
--   google_event_id  el id del evento creado en el calendario de Google de
--                     Yasbleidis — se usa para ACTUALIZAR ese mismo evento
--                     si la citación se reenvía, en vez de crear uno
--                     duplicado cada vez.
--
-- 100% aditivo: no borra ni modifica ninguna columna existente.
-- ============================================================================

alter table public.schedule_events
  add column if not exists modality text not null default 'presencial',
  add column if not exists meet_link text,
  add column if not exists google_event_id text;

alter table public.schedule_events drop constraint if exists schedule_events_modality_check;
alter table public.schedule_events
  add constraint schedule_events_modality_check check (modality in ('presencial', 'virtual'));
