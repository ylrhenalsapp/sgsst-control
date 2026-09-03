-- ============================================================================
-- SG-SST Control · Migración 0010: bolsas de septiembre con valores base
-- ----------------------------------------------------------------------------
-- Sigue a la 0009. Yasbleidis pidió que, además de reiniciar el "Saldo
-- anterior" a 0 desde septiembre, las bolsas de septiembre queden con las
-- "Asignadas" que ella ya tenía calculadas (los valores que antes aparecían
-- como Saldo anterior en la pantalla de Configuración → Sedes y horas):
--   SINCELEJO (AGUAS DE LA SABANA)            -> 84 h
--   COROZAL (AGUAS DE LA SABANA)               -> 14 h
--   PLANTA CARNICOS DE CI CERETE (AVSA)        -> 18 h
--   Almacén Distribuidora de Montería (AVSA)   -> 16 h
--   MONTELIBANO (MANTENIMIENTO Y CONSERVACION) -> 5 h
--   MONTERIA (VEOLIA)                          -> 70 h
-- Las dos sedes de GRUPO EMPRESARIAL VARDI (MONTERÍA AV CIRCUNVALAR = 24h y
-- MONTERÍA MAZDA/AUTOVARDI = 30h) NO se tocan: ya tenían asignación de
-- septiembre cargada y coincide con lo que Yasbleidis quiere.
--
-- No se toca "Usadas" ni hour_records: eso sigue viniendo de los registros
-- reales, y los informes se actualizan solos.
--
-- Cada fila se busca por nombre de EMPRESA (exacto, es único) + un patrón
-- del nombre de SEDE (con comodín al final, por si el nombre completo tiene
-- texto adicional que no se ve completo en pantalla). El bloque aborta con
-- un error claro si alguna fila no encuentra exactamente una sede — así no
-- hay riesgo de asignarle las horas a la sede equivocada por una diferencia
-- de nombre, y si algo falla no se aplica ningún cambio (todo o nada).
-- ============================================================================

do $$
declare
  v_company  text;
  v_pattern  text;
  v_hours    numeric;
  v_site_id  uuid;
  v_count    int;
  v_rows     text[][] := array[
    array['AGUAS DE LA SABANA S.A. E.S.P.', 'SINCELEJO%', '84'],
    array['AGUAS DE LA SABANA S.A. E.S.P.', 'COROZAL%', '14'],
    array['AVSA S.A', 'PLANTA CARNICOS%CERETE%', '18'],
    array['AVSA S.A', 'Almacén Distribuidora%', '16'],
    array['MANTENIMIENTO Y CONSERVACION DE VIAS S.A.S', 'MONTELIBANO%', '5'],
    array['VEOLIA AGUAS DE MONTERIA S.A. E.S.P.', 'MONTERIA%', '70']
  ];
  v_row text[];
begin
  foreach v_row slice 1 in array v_rows loop
    v_company := v_row[1];
    v_pattern := v_row[2];
    v_hours   := v_row[3]::numeric;

    select s.id into v_site_id
    from public.sites s
    join public.companies c on c.id = s.company_id
    where c.name = v_company and s.name ilike v_pattern
    limit 1;

    select count(*) into v_count
    from public.sites s
    join public.companies c on c.id = s.company_id
    where c.name = v_company and s.name ilike v_pattern;

    if v_count <> 1 then
      raise exception 'Empresa=% / patrón de sede=%: se encontraron % coincidencias (se esperaba exactamente 1). Revisar nombres antes de continuar.',
        v_company, v_pattern, v_count;
    end if;

    insert into public.monthly_bags (site_id, month, assigned_hours, assigned_date)
    values (v_site_id, '2026-09-01', v_hours, current_date)
    on conflict (site_id, month) do update set assigned_hours = excluded.assigned_hours;
  end loop;
end;
$$;
