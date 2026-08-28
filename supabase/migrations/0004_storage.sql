-- ============================================================================
-- SG-SST Control · Migración 0004: Storage para evidencias
-- ----------------------------------------------------------------------------
-- El prototipo original solo guardaba el NOMBRE del archivo de evidencia
-- (el archivo real se perdía al recargar la página). Esta migración crea un
-- bucket privado real donde sí se guarda el archivo.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('evidencias', 'evidencias', false)
on conflict (id) do nothing;

create policy "evidencias_select_authenticated"
  on storage.objects for select
  using (bucket_id = 'evidencias' and auth.role() = 'authenticated');

create policy "evidencias_insert_authenticated"
  on storage.objects for insert
  with check (bucket_id = 'evidencias' and auth.role() = 'authenticated');

create policy "evidencias_delete_admin"
  on storage.objects for delete
  using (bucket_id = 'evidencias' and public.current_user_role() = 'admin');
