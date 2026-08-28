/**
 * SG-SST Control · Migración de datos desde localStorage hacia Supabase
 * ---------------------------------------------------------------------------
 * Este script lee la clave "sgsst_control_v1" que usaba la versión anterior
 * (100% navegador) y sube esa información a las tablas reales en Supabase.
 *
 * Cómo usarlo:
 *   1. Abre la plataforma NUEVA en el mismo navegador/computador donde
 *      estaba funcionando la versión anterior (para que localStorage
 *      todavía tenga los datos).
 *   2. Inicia sesión normalmente.
 *   3. Entra a Configuración y pulsa el botón "Migrar datos del navegador
 *      anterior" (una sola vez).
 *   4. Revisa el resumen que se muestra al final antes de seguir usando
 *      la plataforma con normalidad.
 *
 * Es seguro ejecutarlo más de una vez sobre empresas/sedes/actividades
 * (usa "buscar o crear por nombre"), pero horas, evidencias y agenda se
 * insertan tal cual, así que ejecútalo una sola vez para evitar duplicados.
 */
async function runLegacyMigration() {
  const raw = localStorage.getItem('sgsst_control_v1');
  if (!raw) {
    toast('No se encontraron datos de la plataforma anterior en este navegador.');
    return;
  }
  const legacy = JSON.parse(raw);
  const report = { companies: 0, sites: 0, activities: 0, hours: 0, statusHistory: 0, evidences: 0, events: 0, bags: 0, adjustments: 0, errors: [] };

  const companyIdMap = {};   // id local ('veolia') -> uuid real
  const siteIdMap = {};      // id local ('monteria') -> uuid real
  const activityIdMap = {};  // id local (1..5 o timestamp) -> uuid real

  async function findOrCreateCompany(name) {
    let { data } = await sb.from('companies').select('id').eq('name', name).maybeSingle();
    if (data) return data.id;
    const { data: created, error } = await sb.from('companies').insert({ name }).select('id').single();
    if (error) { report.errors.push(`Empresa "${name}": ${error.message}`); return null; }
    report.companies++;
    return created.id;
  }

  async function findOrCreateSite(companyId, name) {
    let { data } = await sb.from('sites').select('id').eq('company_id', companyId).eq('name', name).maybeSingle();
    if (data) return data.id;
    const { data: created, error } = await sb.from('sites').insert({ company_id: companyId, name }).select('id').single();
    if (error) { report.errors.push(`Sede "${name}": ${error.message}`); return null; }
    report.sites++;
    return created.id;
  }

  async function findOrCreateActivity(name, isFixed) {
    let { data } = await sb.from('activities').select('id').eq('name', name).maybeSingle();
    if (data) return data.id;
    const { data: created, error } = await sb.from('activities').insert({ name, is_fixed: !!isFixed }).select('id').single();
    if (error) { report.errors.push(`Actividad "${name}": ${error.message}`); return null; }
    report.activities++;
    return created.id;
  }

  // 1) Empresas y sedes
  for (const c of legacy.companies || []) {
    const companyId = await findOrCreateCompany(c.name);
    companyIdMap[c.id] = companyId;
    for (const s of c.sites || []) {
      const siteId = await findOrCreateSite(companyId, s.name);
      siteIdMap[s.id] = siteId;

      // 1b) Bolsas mensuales + adicionales de esa sede
      for (const [month, bag] of Object.entries(s.monthlyBags || {})) {
        const { data: bagRow, error } = await sb.from('monthly_bags')
          .upsert({
            site_id: siteId,
            month: `${month}-01`,
            assigned_hours: Number(bag.assigned || 0),
            assigned_date: bag.assignedDate || null,
            reason: bag.reason || 'Migrado desde la plataforma anterior',
          }, { onConflict: 'site_id,month' })
          .select('id').single();
        if (error) { report.errors.push(`Bolsa ${s.name} ${month}: ${error.message}`); continue; }
        report.bags++;
        for (const adj of bag.additionalLog || []) {
          const { error: adjErr } = await sb.from('bag_adjustments').insert({
            monthly_bag_id: bagRow.id,
            hours: Number(adj.hours || 0),
            reason: adj.reason || 'Ampliación migrada',
          });
          if (!adjErr) report.adjustments++;
        }
      }
    }
  }

  // 2) Actividades (catálogo)
  for (const t of legacy.tasks || []) {
    activityIdMap[t.id] = await findOrCreateActivity(t.name, t.fixed);
  }

  // 3) Tarifa por defecto
  if (legacy.rate) {
    await sb.from('app_settings').upsert({ key: 'default_rate', value: legacy.rate });
  }

  // 4) Horas ejecutadas
  for (const h of legacy.hours || []) {
    const companyId = companyIdMap[h.companyId];
    const siteId = siteIdMap[h.siteId];
    const activityId = activityIdMap[h.taskId];
    if (!companyId || !siteId || !activityId) { report.errors.push(`Registro de horas ${h.id} omitido (referencia no resuelta).`); continue; }
    const { error } = await sb.from('hour_records').insert({
      company_id: companyId, site_id: siteId, activity_id: activityId,
      record_date: h.date, hours: Number(h.hours), rate: Number(h.rate || 0),
      status: h.status === 'Completado' ? 'Completado' : 'En proceso',
      notes: h.notes || null, source: h.source || 'migracion',
    });
    if (error) report.errors.push(`Registro de horas ${h.id}: ${error.message}`);
    else report.hours++;
  }

  // 5) Historial de avances (estados intermedios, incl. "Pendiente" que no genera horas)
  for (const a of legacy.advances || []) {
    const siteId = siteIdMap[a.siteId];
    const activityId = activityIdMap[a.taskId];
    if (!siteId || !activityId) continue;
    const status = a.status === 'Completado' ? 'Completada' : (a.status === 'Pendiente' ? 'Pendiente' : 'En proceso');
    const { error } = await sb.from('activity_status_history').insert({
      site_id: siteId, activity_id: activityId, status, notes: a.notes || null,
    });
    if (!error) report.statusHistory++;
  }

  // 6) Evidencias (el archivo original no se puede recuperar: el prototipo
  // anterior solo guardaba el nombre del archivo, no su contenido)
  for (const e of legacy.evidences || []) {
    const companyId = companyIdMap[e.companyId];
    const siteId = siteIdMap[e.siteId];
    if (!companyId || !siteId) continue;
    const { error } = await sb.from('evidences').insert({
      company_id: companyId, site_id: siteId, activity_id: activityIdMap[e.taskId] || null,
      record_date: e.date, description: e.desc || null, link: e.link || null,
      file_name: e.fileName || null,
    });
    if (!error) report.evidences++;
  }

  // 7) Agenda
  for (const ev of legacy.calendar || []) {
    const companyId = companyIdMap[ev.companyId];
    const siteId = siteIdMap[ev.siteId];
    const activityId = activityIdMap[ev.taskId];
    if (!companyId || !siteId || !activityId) continue;
    const { error } = await sb.from('schedule_events').insert({
      company_id: companyId, site_id: siteId, activity_id: activityId,
      event_date: ev.date, event_time: ev.time, duration_minutes: Number(ev.duration || 60),
      leader_name: ev.leader || null, leader_email: ev.email || null,
      proposed_date: ev.proposedDate || null, proposed_time: ev.proposedTime || null,
      reminder_minutes: Number(ev.reminder || 30), notes: ev.notes || null,
    });
    if (error) report.errors.push(`Evento de agenda ${ev.id}: ${error.message}`);
    else report.events++;
  }

  console.log('Resumen de migración:', report);
  alert(
    `Migración completada.\n\n` +
    `Empresas nuevas: ${report.companies}\nSedes nuevas: ${report.sites}\nActividades nuevas: ${report.activities}\n` +
    `Horas migradas: ${report.hours}\nEstados de actividad migrados: ${report.statusHistory}\n` +
    `Evidencias migradas: ${report.evidences}\nEventos de agenda migrados: ${report.events}\n` +
    `Bolsas mensuales: ${report.bags}\nAdicionales: ${report.adjustments}\n` +
    (report.errors.length ? `\nErrores (${report.errors.length}), revisa la consola.` : '\nSin errores.')
  );
  return report;
}
