/**
 * SG-SST Control · Lógica de la aplicación (versión conectada a Supabase)
 * ---------------------------------------------------------------------------
 * Mantiene los mismos nombres de función que la versión anterior (para no
 * tocar el HTML) pero ahora lee y escribe en la base de datos real en lugar
 * de localStorage. También corrige dos problemas de la versión anterior:
 *   1. El progreso de cada actividad ya NO es un porcentaje inventado
 *      (55% / 100% / 0% según el estado). Ahora se muestra SIEMPRE la
 *      cantidad real de horas acumuladas, y solo se calcula un % cuando
 *      existe una meta de horas configurada para esa sede/actividad.
 *   2. Las evidencias tipo archivo ahora se guardan de verdad (Supabase
 *      Storage), no solo el nombre del archivo.
 *
 * NOTA: el bloque "V7: AVANCES POR HORAS" que existía al final del app.js
 * original se eliminó a propósito: hacía referencia a IDs de formulario
 * (advCompany, advActivity, advanceModal, etc.) que no existen en ningún
 * lugar del index.html real -> era código muerto de una iteración anterior
 * que nunca llegó a conectarse a la interfaz visible.
 */
const $ = id => document.getElementById(id);
const money = v => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v || 0);
const today = () => new Date().toISOString().slice(0, 10);
const monthOf = d => (d || '').slice(0, 7);
const monthNow = () => new Date().toISOString().slice(0, 7);

function toast(t) { $('toast').textContent = t; $('toast').style.display = 'block'; setTimeout(() => $('toast').style.display = 'none', 2800); }
function options(list, valueField = 'id', textField = 'name') { return list.map(x => `<option value="${x[valueField]}">${x[textField]}</option>`).join(''); }
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

// ---------------------------------------------------------------------------
// Estado en memoria: catálogo (empresas/sedes/actividades) cargado una vez;
// datos operativos (horas, evidencias, agenda, bolsa, estados) recargados
// cada vez que cambian los filtros (refreshAll).
// ---------------------------------------------------------------------------
let state = {
  rate: 50000,
  companies: [],   // [{id,name,sites:[{id,name}]}]
  activities: [],  // [{id,name,is_fixed}]
  hoursSite: [],   // hour_records de la sede seleccionada (todas las fechas)
  evidencesSite: [],
  calendarSite: [],
  statusMap: {},   // `${siteId}|${activityId}` -> 'Pendiente'|'En proceso'|'Completada'
  targetsMap: {},  // `${siteId}|${activityId}` -> target_hours (solo si hay meta configurada)
  siteActivities: [], // [{site_id, activity_id}] -> qué actividades del catálogo aplican a cada sede
  closedMonths: new Set(), // `${siteId}|${'YYYY-MM'}` -> mes cerrado (no admite horas nuevas ni edición)
  bag: { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 },
  bagExists: false,
};

// Iconos y colores decorativos por actividad (solo visual, no afecta datos)
const ACT_ICONS = ['📋', '🎓', '📈', '🔧', '🔍', '📝', '📌', '⚙️'];
const ACT_COLORS = ['iconBlue', 'iconGreen', 'iconPurple', 'iconOrange', 'iconTeal'];
function actIcon(i) { return ACT_ICONS[i % ACT_ICONS.length]; }
function actColor(i) { return ACT_COLORS[i % ACT_COLORS.length]; }

function company() { return state.companies.find(c => c.id === $('filterCompany').value) || state.companies[0]; }
function site() { const c = company(); return c?.sites.find(s => s.id === $('filterSite').value) || c?.sites[0]; }
function selectedMonth() { return $('filterMonth').value || monthNow(); }
function taskName(id) { return state.activities.find(t => t.id === id)?.name || 'Actividad'; }
function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }

// Actividades del catálogo global que están asignadas a una sede en
// concreto (antes toda sede veía TODAS las actividades sin distinción).
function activitiesForSite(siteId) {
  const ids = new Set(state.siteActivities.filter(sa => sa.site_id === siteId).map(sa => sa.activity_id));
  return state.activities.filter(a => ids.has(a.id));
}
function monthClosed(siteId, month) { return state.closedMonths.has(`${siteId}|${month}`); }

function taskStatus(siteId, activityId) { return state.statusMap[`${siteId}|${activityId}`] || 'Pendiente'; }
function taskIsCompleted(siteId, activityId) { return taskStatus(siteId, activityId) === 'Completada'; }
function taskHours(siteId, activityId) { return state.hoursSite.filter(h => h.site_id === siteId && h.activity_id === activityId).reduce((a, x) => a + Number(x.hours), 0); }
function taskMonthHours(siteId, activityId, m) { return state.hoursSite.filter(h => h.site_id === siteId && h.activity_id === activityId && monthOf(h.record_date) === m).reduce((a, x) => a + Number(x.hours), 0); }
// Registro de horas más reciente de una actividad (el que normalmente marcó
// su cierre), usado para ofrecer "Editar horas" sobre actividades ya
// completadas desde el Dashboard / Actividades.
function latestHourRecordForActivity(siteId, activityId) {
  const rows = state.hoursSite.filter(h => h.site_id === siteId && h.activity_id === activityId);
  if (!rows.length) return null;
  return [...rows].sort((a, b) => b.record_date.localeCompare(a.record_date) || String(b.id).localeCompare(String(a.id)))[0];
}

// ---------------------------------------------------------------------------
// Carga inicial (catálogo) y refresco (datos operativos por filtro)
// ---------------------------------------------------------------------------
async function init() {
  // Las 3 consultas de catálogo son independientes entre sí: se piden en
  // paralelo (antes iban una detrás de otra) para que el primer ingreso a
  // la plataforma no tarde la suma de las 3, sino solo la más lenta.
  const [{ data: companies }, { data: activities }, { data: rateRow }, { data: siteActs }] = await Promise.all([
    sb.from('companies').select('id,name,sites(id,name)').order('name'),
    sb.from('activities').select('id,name,is_fixed').order('is_fixed', { ascending: false }).order('name'),
    sb.from('app_settings').select('value').eq('key', 'default_rate').maybeSingle(),
    sb.from('site_activities').select('site_id,activity_id'),
  ]);
  state.companies = (companies || []).map(c => ({ ...c, sites: c.sites || [] }));
  state.activities = activities || [];
  if (rateRow) state.rate = Number(rateRow.value);
  state.siteActivities = siteActs || [];

  $('filterMonth').value = monthNow();
  if ($('calendarDate')) $('calendarDate').value = today();
  $('filterCompany').innerHTML = options(state.companies);
  refreshSitesFilter();
  if ($('reportMonth')) $('reportMonth').value = selectedMonth();
  await refreshAll();
  if (typeof maybeShowWelcomeTour === 'function') maybeShowWelcomeTour();
}

function refreshSitesFilter() {
  const c = company();
  $('filterSite').innerHTML = options(c ? c.sites : []);
  if (!c?.sites.some(s => s.id === $('filterSite').value)) $('filterSite').selectedIndex = 0;
}

async function refreshAll() {
  refreshSitesFilter();
  if ($('reportMonth') && !$('reportMonth').value) $('reportMonth').value = selectedMonth();
  const s = site();
  if (!s) {
    // Todavía no hay ninguna empresa/sede creada (primera vez usando el
    // panel, o justo después de vaciar los datos de prueba). No hay nada
    // que consultar por sede, pero igual hay que pintar Configuración para
    // que aparezcan los botones "+ Agregar empresa" / "+ Agregar sede" /
    // "+ Nueva actividad" — antes esta función se detenía aquí mismo y
    // Configuración se quedaba en blanco para siempre.
    state.hoursSite = []; state.evidencesSite = []; state.calendarSite = [];
    state.statusMap = {}; state.targetsMap = {};
    state.bag = { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 };
    state.bagExists = false;
    state.closedMonths = new Set();
    renderBagAlert();
    renderDashboard();
    renderActivities();
    renderHours();
    renderMonthCloseBanner();
    renderEvidences();
    await renderConfig();
    renderCalendar();
    renderNotifBell();
    renderMiniCalendar();
    if (typeof renderFullCalendar === 'function') renderFullCalendar();
    return;
  }

  // Las 7 consultas de esta sección tampoco dependen unas de otras, así que
  // también van todas en paralelo (se agregó aquí la de "monthly_bags" que
  // antes se pedía aparte, después de esperar todo lo anterior).
  const [{ data: hours }, { data: evid }, { data: cal }, { data: statusRows }, { data: bagRow }, { data: targetRows }, { count }, { data: closedRows }] = await Promise.all([
    sb.from('hour_records').select('*').eq('site_id', s.id),
    sb.from('evidences').select('*').eq('site_id', s.id).order('record_date', { ascending: false }),
    sb.from('schedule_events').select('*').eq('site_id', s.id),
    sb.from('v_activity_current_status').select('*').eq('site_id', s.id),
    sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${selectedMonth()}-01` }),
    sb.from('activity_targets').select('activity_id,target_hours').eq('site_id', s.id),
    sb.from('monthly_bags').select('id', { count: 'exact', head: true }).eq('site_id', s.id).eq('month', `${selectedMonth()}-01`),
    sb.from('month_closures').select('month').eq('site_id', s.id).is('reopened_at', null),
  ]);
  state.hoursSite = hours || [];
  state.evidencesSite = evid || [];
  state.calendarSite = cal || [];
  state.statusMap = {};
  (statusRows || []).forEach(r => { state.statusMap[`${r.site_id}|${r.activity_id}`] = r.status; });
  state.targetsMap = {};
  (targetRows || []).forEach(r => { state.targetsMap[`${s.id}|${r.activity_id}`] = Number(r.target_hours); });
  state.bag = (bagRow && bagRow[0]) || { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 };
  state.bagExists = !!count;
  state.closedMonths = new Set((closedRows || []).map(r => `${s.id}|${r.month.slice(0, 7)}`));

  renderBagAlert();
  renderDashboard();
  renderActivities();
  renderHours();
  renderMonthCloseBanner();
  renderEvidences();
  renderConfig();
  renderCalendar();
  renderNotifBell();
  renderMiniCalendar();
  if (typeof renderFullCalendar === 'function') renderFullCalendar();
}

// ---------------------------------------------------------------------------
// Mini calendario decorativo del panel "Acciones rápidas" (solo visual, no
// interactivo: muestra el mes actual con el día de hoy resaltado). El
// calendario completo con eventos reales sigue viviendo en la sección
// "Calendario" (renderCalendar / renderFullCalendar en calendarView.js).
// ---------------------------------------------------------------------------
function renderMiniCalendar() {
  const el = $('miniCalendar');
  if (!el) return;
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayNum = now.getDate();
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="miniCalDay empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    cells += `<span class="miniCalDay${d === todayNum ? ' today' : ''}">${d}</span>`;
  }
  el.innerHTML = `
    <div class="miniCalHead">${monthNames[month]} ${year}</div>
    <div class="miniCalGrid miniCalGridHead">
      <span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span>
    </div>
    <div class="miniCalGrid">${cells}</div>`;
}

function activityTarget(siteId, activityId) { return state.targetsMap[`${siteId}|${activityId}`] || null; }
function activityProgressBar(siteId, activityId, totalH) {
  const target = activityTarget(siteId, activityId);
  if (!target) return '';
  const pct = Math.min(100, Math.round((totalH / target) * 100));
  return `<div class="progressRow"><div class="bar"><div class="fill" style="width:${pct}%"></div></div><span class="pct">${pct}%</span></div>`;
}

function filteredHours() { const s = site(), m = selectedMonth(); return state.hoursSite.filter(x => x.site_id === s.id && monthOf(x.record_date) === m); }

function renderBagAlert() {
  const banner = $('bagAlertBanner');
  if (!banner) return;
  if (!site()) { banner.style.display = 'none'; return; }
  if (!state.bagExists) {
    banner.style.display = 'block';
    banner.innerHTML = `⚠️ Todavía no se ha creado la <b>bolsa de horas de ${selectedMonth()}</b> para esta sede. <button class="secondary" style="margin-left:8px" onclick="openMonthlyBagModal()">+ Asignar bolsa del mes</button>`;
  } else {
    banner.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function renderDashboard() {
  const s = site();
  if (!s) {
    $('mAssigned').textContent = '0 h'; $('mUsed').textContent = '0 h'; $('mRemaining').textContent = '0 h'; $('mValue').textContent = money(0);
    document.querySelector('#mAssigned').parentElement.querySelector('.sub').textContent = 'Asignadas: 0 h · Saldo anterior: 0 h · Adicionales: 0 h';
    document.querySelector('#mRemaining').parentElement.querySelector('.sub').textContent = `Disponible para ${selectedMonth()}`;
    $('dashboardActivities').innerHTML = '<p class="empty">Todavía no tienes ninguna empresa registrada. Ve a Configuración → Empresas y agrega la primera para empezar.</p>';
    $('recentRecords').innerHTML = '<div class="empty">Aún no hay registros.</div>';
    return;
  }
  const m = selectedMonth(), bag = state.bag;
  const hs = filteredHours(), value = hs.reduce((a, x) => a + Number(x.hours) * Number(x.rate), 0);
  $('mAssigned').textContent = bag.total + ' h';
  $('mUsed').textContent = bag.used + ' h';
  $('mRemaining').textContent = bag.remaining + ' h';
  $('mValue').textContent = money(value);
  document.querySelector('#mAssigned').parentElement.querySelector('.sub').textContent = `Asignadas: ${bag.assigned} h · Saldo anterior: ${bag.carry} h · Adicionales: ${bag.additional} h`;
  document.querySelector('#mRemaining').parentElement.querySelector('.sub').textContent = `Disponible para ${m}`;

  const dashActs = activitiesForSite(s.id);
  $('dashboardActivities').innerHTML = dashActs.length ? dashActs.map((t, i) => {
    const status = taskStatus(s.id, t.id), completed = status === 'Completada';
    const totalH = taskHours(s.id, t.id), monthH = taskMonthHours(s.id, t.id, m);
    const btn = completed ? completedActivityButton(s.id, t.id)
      : `<button class="secondary" data-requires-write onclick="openActivityModal('${t.id}')">Registrar horas / actualizar</button>`;
    return `<div class="activity">
      <div class="activityTop">
        <div class="activityIcon ${actColor(i)}">${actIcon(i)}</div>
        <div><h3>${t.name}</h3><div class="small">${completed ? 'Actividad cerrada. No admite más horas ni nuevos registros.' : 'Actividad abierta para registrar horas en diferentes días.'}</div></div>
        <span class="badge ${completed ? 'done' : status === 'En proceso' ? 'progress' : 'pending'}">${status}</span>
      </div>
      <div class="small" style="margin-top:8px"><b>${totalH} h acumuladas</b> · ${monthH} h en ${m}${completed ? ' · Actividad completada' : ''}</div>
      ${activityProgressBar(s.id, t.id, totalH)}
      <div style="margin-top:10px">${btn}</div>
    </div>`;
  }).join('') : '<p class="empty">Esta sede todavía no tiene actividades asignadas. Agrégalas desde Configuración → Actividades.</p>';

  const rec = [...filteredHours()].sort((a, b) => b.record_date.localeCompare(a.record_date)).slice(0, 5);
  $('recentRecords').innerHTML = rec.length ? rec.map(x => `<div style="padding:9px 0;border-bottom:1px solid var(--line)"><b>${x.record_date}</b><div class="small">${taskName(x.activity_id)} · ${x.hours} h · ${x.status}</div></div>`).join('') : '<div class="empty">Aún no hay registros en este periodo.</div>';
}

function renderActivities() {
  const s = site();
  if (!s) { $('activitiesList').innerHTML = '<p class="empty">Todavía no tienes ninguna empresa registrada. Ve a Configuración → Empresas y agrega la primera para empezar.</p>'; return; }
  const m = selectedMonth();
  const acts = activitiesForSite(s.id);
  $('activitiesList').innerHTML = acts.length ? acts.map((t, i) => {
    const status = taskStatus(s.id, t.id), completed = status === 'Completada';
    const totalH = taskHours(s.id, t.id), monthH = taskMonthHours(s.id, t.id, m);
    return `<div class="activity">
      <div class="activityTop">
        <div class="activityIcon ${actColor(i)}">${actIcon(i)}</div>
        <div><h3>${t.name}</h3><div class="small">${completed ? 'Actividad completada. Puedes corregir sus horas mientras el mes no esté cerrado.' : 'Sin cierre todavía.'}</div></div>
        <div>${completed ? completedActivityButton(s.id, t.id) : `<button class="secondary" data-requires-write onclick="openActivityModal('${t.id}')">Registrar horas</button>`}</div>
      </div>
      <div class="small" style="margin:8px 0"><b>${totalH} h acumuladas</b> · ${monthH} h en el mes seleccionado</div>
      ${activityProgressBar(s.id, t.id, totalH)}
      <span class="badge ${completed ? 'done' : status === 'En proceso' ? 'progress' : 'pending'}">${status}</span>
    </div>`;
  }).join('') : '<p class="empty">Esta sede todavía no tiene actividades asignadas. Agrégalas desde Configuración → Actividades.</p>';
}

// Botón para una actividad ya "Completada": si tiene un registro de horas y
// el mes de ese registro sigue abierto, deja editarlo (cambiar horas y
// volver a guardar); si el mes ya está cerrado, se informa que está
// bloqueada en vez de ofrecer un botón que fallaría al guardar.
function completedActivityButton(siteId, activityId) {
  const latest = latestHourRecordForActivity(siteId, activityId);
  if (!latest) return `<button class="secondary" disabled style="opacity:.55;cursor:not-allowed">✓ Completada</button>`;
  if (monthClosed(siteId, monthOf(latest.record_date))) {
    return `<span class="badge done" title="El mes de este registro ya está cerrado">🔒 Completada (mes cerrado)</span>`;
  }
  return `<button class="secondary" data-requires-write onclick="editHours('${latest.id}')">✏️ Editar horas</button>`;
}

function renderHours() {
  const s = site();
  if (!s) { $('hoursTable').innerHTML = '<tr><td colspan="9" class="empty">Todavía no tienes ninguna empresa registrada.</td></tr>'; return; }
  const rows = state.hoursSite.filter(x => x.site_id === s.id).sort((a, b) => b.record_date.localeCompare(a.record_date));
  $('hoursTable').innerHTML = rows.length ? rows.map(x => {
    const closed = monthClosed(s.id, monthOf(x.record_date));
    const editBtn = closed
      ? `<span class="small" title="El mes de este registro ya está cerrado">🔒 Cerrado</span>`
      : `<button class="secondary" data-requires-write onclick="editHours('${x.id}')">Editar</button>`;
    return `<tr><td>${x.record_date}</td><td>${company().name}<br><span class="small">${s.name}</span></td><td>${taskName(x.activity_id)}</td><td><span class="badge ${x.status === 'Completado' ? 'done' : 'progress'}">${x.status}</span></td><td>${x.hours}</td><td>${money(x.rate)}</td><td>${money(x.hours * x.rate)}</td><td><button class="badge ${x.paid ? 'paid' : 'unpaid'}" data-requires-write onclick="togglePaid('${x.id}',${!x.paid})">${x.paid ? '✓ Pagado' : '⏳ Pendiente'}</button></td><td style="white-space:nowrap">${editBtn} <button class="danger" data-requires-write onclick="deleteItem('hour_records','${x.id}')">Eliminar</button></td></tr>`;
  }).join('') : `<tr><td colspan="9" class="empty">No hay horas registradas.</td></tr>`;
}

// ---------------------------------------------------------------------------
// Cierre mensual manual por sede (banner + acciones). Mientras el mes no se
// cierre, las horas se pueden seguir editando; una vez cerrado, no se pueden
// agregar ni editar horas de ese mes (se puede reabrir si hace falta).
// ---------------------------------------------------------------------------
const MONTH_NAMES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function renderMonthCloseBanner() {
  const el = $('monthCloseBanner'); if (!el) return;
  const s = site(); if (!s) { el.innerHTML = ''; return; }
  const m = selectedMonth(), now = monthNow();
  const closed = monthClosed(s.id, m);

  if (m > now) { el.innerHTML = ''; return; } // mes futuro: nada que cerrar todavía

  if (closed) {
    el.innerHTML = `<div class="monthCloseBanner closedBanner">🔒 <b>Mes ${m} cerrado</b> para ${s.name}. Las horas de este mes ya no se pueden editar ni agregar.
      <button class="secondary" data-requires-write onclick="reopenMonth()">Reabrir mes</button></div>`;
    return;
  }

  if (m === now) {
    const today_ = new Date();
    const lastDay = new Date(today_.getFullYear(), today_.getMonth() + 1, 0);
    const daysLeft = Math.max(0, Math.ceil((lastDay - today_) / 86400000));
    const lastDayLabel = `${lastDay.getDate()} de ${MONTH_NAMES_ES[lastDay.getMonth()]}`;
    el.innerHTML = `<div class="monthCloseBanner openBanner">🗓️ Faltan <b>${daysLeft} día${daysLeft === 1 ? '' : 's'}</b> para terminar el mes · <b>Cierre de mes: ${lastDayLabel}</b>. Cierra el mes cuando ya hayas organizado y distribuido todas las horas.
      <button class="primary" data-requires-write onclick="closeMonth()">Cerrar mes</button></div>`;
    return;
  }

  el.innerHTML = `<div class="monthCloseBanner openBanner">⚠️ El mes ${m} ya pasó y todavía no se ha cerrado para ${s.name}.
    <button class="primary" data-requires-write onclick="closeMonth()">Cerrar mes</button></div>`;
}

async function closeMonth() {
  const s = site(); if (!s) return;
  const m = selectedMonth();
  if (!confirm(`¿Cerrar el mes ${m} para ${s.name}? Después de cerrarlo no se podrán agregar ni editar horas de ese mes (puedes reabrirlo si necesitas corregir algo).`)) return;
  const { error } = await sb.from('month_closures').insert({ site_id: s.id, month: `${m}-01`, closed_by: currentProfile?.id });
  if (error) return toast('No se pudo cerrar el mes: ' + error.message);
  await refreshAll();
  toast(`Mes ${m} cerrado para ${s.name}.`);
}

async function reopenMonth() {
  const s = site(); if (!s) return;
  const m = selectedMonth();
  if (!confirm(`¿Reabrir el mes ${m} para ${s.name}? Se podrán volver a editar y agregar horas.`)) return;
  const { error } = await sb.from('month_closures').update({ reopened_at: new Date().toISOString(), reopened_by: currentProfile?.id }).eq('site_id', s.id).eq('month', `${m}-01`).is('reopened_at', null);
  if (error) return toast('No se pudo reabrir el mes: ' + error.message);
  await refreshAll();
  toast(`Mes ${m} reabierto para ${s.name}.`);
}

async function togglePaid(id, value) {
  const { error } = await sb.from('hour_records').update({ paid: value }).eq('id', id);
  if (error) return toast('No se pudo actualizar el pago: ' + error.message);
  await refreshAll();
  toast(value ? '✓ Registro marcado como pagado.' : 'Registro marcado como pendiente de pago.');
}

// ---------------------------------------------------------------------------
// Campana de notificaciones (resumen de actividades pendientes y últimos registros)
// ---------------------------------------------------------------------------
function renderNotifBell() {
  const s = site(); if (!s) return;
  const pendingCount = state.activities.filter(t => !taskIsCompleted(s.id, t.id)).length;
  const countEl = $('notifCount');
  if (countEl) {
    if (pendingCount > 0) { countEl.style.display = 'inline-flex'; countEl.textContent = pendingCount; }
    else countEl.style.display = 'none';
  }
  const recent = [...state.hoursSite].sort((a, b) => b.record_date.localeCompare(a.record_date)).slice(0, 4);
  const panel = $('notifPanel');
  if (panel) {
    panel.innerHTML = `<div class="notifTitle">📋 Actividades pendientes: ${pendingCount}</div>` +
      (recent.length ? recent.map(x => `<div class="notifItem"><b>${taskName(x.activity_id)}</b><br><span class="small">${x.record_date} · ${x.hours} h · ${x.paid ? 'Pagado' : 'Pendiente de pago'}</span></div>`).join('')
        : '<div class="notifItem small">Sin registros recientes.</div>');
  }
}

function renderEvidences() {
  const rows = state.evidencesSite;
  $('evidenceTable').innerHTML = rows.length ? rows.map(x => `<tr><td>${x.record_date}</td><td>${taskName(x.activity_id)}</td><td>${x.description || '-'}</td><td>${x.link ? `<a class="link" href="${safeUrl(x.link)}" target="_blank">🔗 Abrir link</a>` : ''}${x.storage_path ? `<div class="small"><a class="link" href="#" onclick="openEvidenceFile('${x.id}');return false">📄 ${x.file_name || 'archivo'}</a></div>` : ''}</td><td><button class="danger" data-requires-write onclick="deleteItem('evidences','${x.id}')">Eliminar</button></td></tr>`).join('') : `<tr><td colspan="5" class="empty">No hay evidencias registradas.</td></tr>`;
}

async function openEvidenceFile(id) {
  const ev = state.evidencesSite.find(x => x.id === id);
  if (!ev?.storage_path) return;
  const { data, error } = await sb.storage.from('evidencias').createSignedUrl(ev.storage_path, 60);
  if (error) return toast('No se pudo abrir el archivo: ' + error.message);
  window.open(data.signedUrl, '_blank');
}

function showSection(id, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  if (el) el.classList.add('active');
  $('pageTitle').textContent = el ? el.textContent.trim().replace(/^[^\wÁÉÍÓÚÜÑáéíóúüñ]+\s*/, '') : 'Dashboard';
}
function fillCommon(companyId, siteId, taskId) { $(companyId).innerHTML = options(state.companies); $(taskId).innerHTML = options(state.activities); fillSiteSelect(companyId, siteId); }
function fillSiteSelect(companyId, siteId) { const c = state.companies.find(x => x.id === $(companyId).value) || state.companies[0]; $(siteId).innerHTML = options(c ? c.sites : []); }

// ---------------------------------------------------------------------------
// Registro de horas
// ---------------------------------------------------------------------------
async function updateHoursBagInfo() {
  const c = state.companies.find(x => x.id === $('hCompany').value), s = c?.sites.find(x => x.id === $('hSite').value), m = monthOf($('hDate').value) || selectedMonth();
  if (!s) return;
  const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
  const b = (data && data[0]) || { assigned: 0, carry: 0, additional: 0, remaining: 0 };
  $('hBagInfo').innerHTML = `<b>Bolsa de ${m}:</b> Asignadas ${b.assigned} h · Saldo anterior ${b.carry} h · Adicionales ${b.additional} h · <b>Disponible ${b.remaining} h</b>`;
}
function refreshHourTaskOptions() {
  const s = state.companies.find(x => x.id === $('hCompany').value)?.sites.find(x => x.id === $('hSite').value);
  const list = s ? activitiesForSite(s.id) : state.activities;
  $('hTask').innerHTML = list.map(t => `<option value="${t.id}" ${s && taskIsCompleted(s.id, t.id) ? 'disabled' : ''}>${t.name}${s && taskIsCompleted(s.id, t.id) ? ' — COMPLETADA' : ''}</option>`).join('');
}
// null = registrar horas nuevas; con id = editando un registro ya existente.
let editingHourId = null;
function openHoursModal() {
  if (!company() || !site()) return toast('Primero agrega una empresa y una sede desde Configuración.');
  editingHourId = null;
  $('hoursModalTitle').textContent = 'Registrar horas';
  $('hRate').disabled = true;
  fillCommon('hCompany', 'hSite', 'hTask'); $('hCompany').value = company().id; fillSiteSelect('hCompany', 'hSite'); $('hSite').value = site().id;
  $('hDate').value = today(); $('hRate').value = state.rate; $('hHours').value = ''; $('hStatus').value = 'En proceso'; $('hTotal').value = ''; $('hNotes').value = '';
  refreshHourTaskOptions(); updateHoursBagInfo(); openModal('hoursModal');
}
function editHours(id) {
  const r = state.hoursSite.find(x => x.id === id); if (!r) return;
  if (monthClosed(r.site_id, monthOf(r.record_date))) return toast('Este mes ya está cerrado. Usa "Reabrir mes" en Registro de horas si necesitas corregirlo.');
  editingHourId = id;
  $('hoursModalTitle').textContent = 'Editar horas';
  const c = state.companies.find(x => x.sites.some(s => s.id === r.site_id));
  fillCommon('hCompany', 'hSite', 'hTask');
  $('hCompany').value = c ? c.id : company().id; fillSiteSelect('hCompany', 'hSite'); $('hSite').value = r.site_id;
  refreshHourTaskOptions();
  $('hTask').value = r.activity_id;
  $('hDate').value = r.record_date; $('hRate').value = r.rate; $('hHours').value = r.hours; $('hStatus').value = r.status; $('hTotal').value = money(r.hours * r.rate); $('hNotes').value = r.notes || '';
  updateHoursBagInfo(); openModal('hoursModal');
}
$('hHours')?.addEventListener('input', () => { $('hTotal').value = money(Number($('hHours').value || 0) * Number($('hRate').value || state.rate)); });
$('hDate')?.addEventListener('change', updateHoursBagInfo);
$('hCompany')?.addEventListener('change', () => { fillSiteSelect('hCompany', 'hSite'); refreshHourTaskOptions(); updateHoursBagInfo(); });
$('hSite')?.addEventListener('change', () => { refreshHourTaskOptions(); updateHoursBagInfo(); });

async function saveHours() {
  const h = Number($('hHours').value); if (!h || h <= 0) return toast('Ingresa una cantidad válida de horas');
  const c = state.companies.find(x => x.id === $('hCompany').value), s = c?.sites.find(x => x.id === $('hSite').value), taskId = $('hTask').value, m = monthOf($('hDate').value);
  if (!s) return toast('Selecciona una sede válida');
  const wasEditing = !!editingHourId;
  // El bloqueo de "actividad completada" solo aplica a horas NUEVAS. Si ya
  // existía el registro (se abrió con "Editar"), se debe poder corregir sus
  // horas aunque la actividad haya quedado marcada como Completada — el
  // único candado real para un registro existente es que el mes de esa
  // fecha ya esté cerrado (chequeo siguiente).
  if (!wasEditing && taskIsCompleted(s.id, taskId)) return toast('Esta actividad ya está completada y no admite más horas.');
  if (monthClosed(s.id, m)) return toast('Ese mes ya está cerrado para esta sede. Reábrelo primero si necesitas cambiar algo.');
  const editingRecord = wasEditing ? state.hoursSite.find(x => x.id === editingHourId) : null;
  const oldHours = (editingRecord && editingRecord.site_id === s.id && monthOf(editingRecord.record_date) === m) ? Number(editingRecord.hours) : 0;
  const { data: bagData } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
  const available = ((bagData && bagData[0]?.remaining) || 0) + oldHours;
  if (h > available) {
    toast(`Para ${m} solo quedan ${available} h en la bolsa. Puedes agregar horas adicionales al mes.`);
    if (!wasEditing) { closeModal('hoursModal'); openAdditionalHoursModal(c.id, s.id, m); }
    return;
  }
  const status = $('hStatus').value;
  let error;
  if (wasEditing) {
    ({ error } = await sb.from('hour_records').update({
      company_id: c.id, site_id: s.id, activity_id: taskId, record_date: $('hDate').value,
      hours: h, rate: Number($('hRate').value) || state.rate, status, notes: $('hNotes').value,
    }).eq('id', editingHourId));
  } else {
    ({ error } = await sb.from('hour_records').insert({
      company_id: c.id, site_id: s.id, activity_id: taskId, record_date: $('hDate').value,
      hours: h, rate: state.rate, status, notes: $('hNotes').value,
      created_by: currentProfile?.id,
    }));
  }
  if (error) return toast('No se pudo guardar: ' + error.message);
  editingHourId = null;
  closeModal('hoursModal'); await refreshAll();
  toast(wasEditing ? 'Horas actualizadas.' : (status === 'Completado' ? 'Horas registradas y actividad cerrada.' : 'Horas registradas. La actividad queda abierta para nuevos días.'));
}

// ---------------------------------------------------------------------------
// Avance de actividad
// ---------------------------------------------------------------------------
async function updateActivityBagInfo() {
  const s = state.companies.find(x => x.id === $('aCompany').value)?.sites.find(x => x.id === $('aSite').value), m = selectedMonth();
  if (!s) return;
  const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
  const b = (data && data[0]) || { remaining: 0 };
  $('aBagInfo').innerHTML = `<b>Bolsa disponible:</b> ${b.remaining} h para ${m}. Las horas registradas en este avance se descuentan directamente de esta bolsa.`;
}
// Opciones del select de actividad: cada actividad completada queda deshabilitada
// (visible mas no seleccionable), en vez de bloquear todo el modal por una sola.
function activityTaskOptions(siteId, selectedId) {
  return activitiesForSite(siteId).map(t => {
    const completed = taskIsCompleted(siteId, t.id);
    const sel = t.id === selectedId ? 'selected' : '';
    return `<option value="${t.id}" ${completed ? 'disabled' : ''} ${sel}>${t.name}${completed ? ' — COMPLETADA' : ''}</option>`;
  }).join('');
}
// Primera actividad NO completada de la sede (o la primera de las suyas si están todas completadas).
function firstOpenActivity(siteId) {
  const acts = activitiesForSite(siteId);
  const open = acts.find(t => !taskIsCompleted(siteId, t.id));
  return open ? open.id : (acts[0]?.id || null);
}
function openActivityModal(taskId) {
  if (!company() || !site()) return toast('Primero agrega una empresa y una sede desde Configuración.');
  $('aCompany').innerHTML = options(state.companies); $('aCompany').value = company().id;
  fillSiteSelect('aCompany', 'aSite'); $('aSite').value = site().id;
  const s = site();
  if (!s) return;
  const acts = activitiesForSite(s.id);
  if (!acts.length) { toast('Esta sede todavía no tiene actividades asignadas. Agrégalas desde Configuración → Actividades.'); return; }
  if (acts.every(t => taskIsCompleted(s.id, t.id))) { toast('Todas las actividades de esta sede ya están completadas.'); return; }
  const chosen = taskId || firstOpenActivity(s.id);
  $('aTask').innerHTML = activityTaskOptions(s.id, chosen);
  $('aTask').value = chosen;
  refreshActivityModalState();
  openModal('activityModal');
}
// Se ejecuta cada vez que cambia la actividad elegida en el modal: actualiza
// el estado propuesto y la bolsa disponible SIN cerrar el modal (antes solo
// se validaba una vez al abrir, usando siempre la primera actividad del
// catálogo — si esa venía completada, el botón "+ Registrar avance" no hacía
// nada visible).
function refreshActivityModalState() {
  const s = state.companies.find(x => x.id === $('aCompany').value)?.sites.find(x => x.id === $('aSite').value);
  const tid = $('aTask').value;
  if (!s || !tid) return;
  $('aStatus').value = taskStatus(s.id, tid) === 'Pendiente' ? 'Pendiente' : 'En proceso';
  $('aHours').value = 0; $('aNotes').value = '';
  updateActivityBagInfo();
}
function refreshActivityCompanySite() {
  fillSiteSelect('aCompany', 'aSite');
  const s = state.companies.find(x => x.id === $('aCompany').value)?.sites.find(x => x.id === $('aSite').value);
  if (!s) return;
  const chosen = firstOpenActivity(s.id);
  $('aTask').innerHTML = activityTaskOptions(s.id, chosen);
  $('aTask').value = chosen;
  refreshActivityModalState();
}
$('aCompany')?.addEventListener('change', refreshActivityCompanySite);
$('aSite')?.addEventListener('change', () => {
  const s = state.companies.find(x => x.id === $('aCompany').value)?.sites.find(x => x.id === $('aSite').value);
  if (!s) return;
  const chosen = firstOpenActivity(s.id);
  $('aTask').innerHTML = activityTaskOptions(s.id, chosen);
  $('aTask').value = chosen;
  refreshActivityModalState();
});
$('aTask')?.addEventListener('change', refreshActivityModalState);

async function saveActivity() {
  const c = state.companies.find(x => x.id === $('aCompany').value), s = c?.sites.find(x => x.id === $('aSite').value), tid = $('aTask').value;
  if (!c || !s) return toast('Selecciona una empresa y sede válida.');
  if (taskIsCompleted(s.id, tid)) return toast('La actividad ya fue completada y no puede modificarse.');
  const status = $('aStatus').value, hours = Number($('aHours').value || 0), m = selectedMonth();
  if (hours < 0) return toast('Las horas no pueden ser negativas.');
  if (hours === 0 && status !== 'Completado') return toast('Ingresa las horas ejecutadas en este avance.');

  if (hours > 0) {
    const { data: bagData } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
    const available = (bagData && bagData[0]?.remaining) || 0;
    if (hours > available) { toast(`Para ${m} solo quedan ${available} h en la bolsa. Debes agregar horas adicionales para continuar.`); closeModal('activityModal'); openAdditionalHoursModal(c.id, s.id, m); return; }
    const { error } = await sb.from('hour_records').insert({
      company_id: c.id, site_id: s.id, activity_id: tid, record_date: today(),
      hours, rate: state.rate, status, notes: $('aNotes').value, source: 'avance', created_by: currentProfile?.id,
    });
    if (error) return toast('No se pudo guardar: ' + error.message);
  } else {
    // Pendiente/En proceso sin horas: solo cambia el estado, sin registrar horas.
    const { error } = await sb.from('activity_status_history').insert({
      site_id: s.id, activity_id: tid, status: status === 'Completado' ? 'Completada' : status, notes: $('aNotes').value, changed_by: currentProfile?.id,
    });
    if (error) return toast('No se pudo guardar: ' + error.message);
  }
  closeModal('activityModal'); await refreshAll();
  toast(status === 'Completado' ? (hours > 0 ? `Se registraron ${hours} h y la actividad quedó completada.` : 'Actividad completada y bloqueada.') : `Se registraron ${hours} h. La actividad sigue abierta para nuevos días.`);
}

// ---------------------------------------------------------------------------
// Evidencias
// ---------------------------------------------------------------------------
function refreshEvidenceTaskOptions() {
  const s = state.companies.find(x => x.id === $('eCompany').value)?.sites.find(x => x.id === $('eSite').value);
  $('eTask').innerHTML = options(s ? activitiesForSite(s.id) : state.activities);
}
function openEvidenceModal() { if (!company() || !site()) return toast('Primero agrega una empresa y una sede desde Configuración.'); fillCommon('eCompany', 'eSite', 'eTask'); $('eCompany').value = company().id; fillSiteSelect('eCompany', 'eSite'); $('eSite').value = site().id; refreshEvidenceTaskOptions(); $('eDate').value = today(); $('eLink').value = ''; $('eDesc').value = ''; $('eFile').value = ''; openModal('evidenceModal'); }
$('eCompany')?.addEventListener('change', () => { fillSiteSelect('eCompany', 'eSite'); refreshEvidenceTaskOptions(); });
$('eSite')?.addEventListener('change', refreshEvidenceTaskOptions);
async function saveEvidence() {
  const file = $('eFile').files[0], link = $('eLink').value.trim();
  if (!file && !link) return toast('Carga un archivo o agrega un link');
  const c = $('eCompany').value, s = $('eSite').value, t = $('eTask').value;
  let storagePath = null, fileName = null;
  if (file) {
    storagePath = `${s}/${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage.from('evidencias').upload(storagePath, file);
    if (upErr) return toast('No se pudo subir el archivo: ' + upErr.message);
    fileName = file.name;
  }
  const { error } = await sb.from('evidences').insert({
    company_id: c, site_id: s, activity_id: t, record_date: $('eDate').value,
    link: link || null, description: $('eDesc').value, storage_path: storagePath, file_name: fileName, created_by: currentProfile?.id,
  });
  if (error) return toast('No se pudo guardar: ' + error.message);
  closeModal('evidenceModal'); await refreshAll(); toast('Evidencia registrada');
}

async function deleteItem(table, id) {
  if (!confirm('¿Eliminar este registro?')) return;
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) return toast('No se pudo eliminar (verifica tus permisos): ' + error.message);
  await refreshAll(); toast('Registro eliminado');
}

// ---------------------------------------------------------------------------
// Configuración: empresas, sedes, tarifas, actividades
// ---------------------------------------------------------------------------
function showConfig(tab, btn) {
  ['companies', 'sites', 'rates', 'tasks', 'migration'].forEach(x => $('cfg-' + x).style.display = x === tab ? 'block' : 'none');
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function renderConfig() {
  const m = selectedMonth();
  $('cfg-companies').innerHTML = `<div class="panelhead"><h2>Empresas</h2><button class="primary" data-requires-write onclick="openCompanyWizard()">+ Agregar empresa</button></div><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sedes</th><th></th></tr></thead><tbody>${state.companies.map(c => `<tr><td>${c.name}</td><td>${c.sites.length}</td><td><button class="danger" data-requires-write onclick="removeCompany('${c.id}')">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`;

  const rows = [];
  for (const c of state.companies) {
    for (const s of c.sites) {
      const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
      const b = (data && data[0]) || { assigned: 0, carry: 0, additional: 0, used: 0, remaining: 0 };
      rows.push(`<tr><td>${c.name}</td><td>${s.name}</td><td>${b.assigned} h</td><td>${b.carry} h</td><td>${b.additional} h</td><td>${b.used} h</td><td><b>${b.remaining} h</b></td><td style="white-space:nowrap"><button class="primary" data-requires-write onclick="openMonthlyBagModal('${c.id}','${s.id}','${m}')">Asignar</button> <button class="success" data-requires-write onclick="openAdditionalHoursModal('${c.id}','${s.id}','${m}')">+ Horas</button> <button class="secondary" data-requires-write onclick="openSiteActivitiesModal('${c.id}','${s.id}')">Actividades</button> <button class="danger" data-requires-write onclick="removeSite('${c.id}','${s.id}')">Eliminar</button></td></tr>`);
    }
  }
  $('cfg-sites').innerHTML = `<div class="panelhead"><h2>Bolsas mensuales de horas</h2><div><button class="success" data-requires-write onclick="openMonthlyBagModal()">+ Asignar bolsa del mes</button> <button class="primary" data-requires-write onclick="openSiteWizard()">+ Agregar sede</button></div></div><p class="small">Periodo mostrado: <b>${m}</b>. El saldo no utilizado del mes anterior se suma automáticamente como saldo a favor.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Asignadas</th><th>Saldo anterior</th><th>Adicionales</th><th>Usadas</th><th>Disponibles</th><th>Acción</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  $('cfg-rates').innerHTML = `<div class="panelhead"><h2>Tarifa de referencia</h2></div><div class="formgrid"><div><label>Valor por hora (COP)</label><input id="globalRate" type="number" value="${state.rate}"></div></div><div class="actions"><button class="primary" data-requires-write onclick="updateRate()">Guardar tarifa</button></div><p class="small">La tarifa configurada se propone para nuevos registros. Cada registro conserva su propia tarifa.</p>`;
  $('cfg-tasks').innerHTML = `<div class="panelhead"><h2>Actividades del proyecto</h2><button class="primary" data-requires-write onclick="addTaskPrompt()">+ Nueva actividad</button></div>${state.activities.map(t => `<div class="activity"><b>${t.name}</b>${t.is_fixed ? '<div class="small">Actividad inicial establecida</div>' : '<div class="small">Actividad agregada</div>'}</div>`).join('')}`;
}

async function removeCompany(id) { if (state.companies.length <= 1) return toast('Debe existir al menos una empresa'); if (confirm('¿Eliminar empresa y sus sedes?')) { const { error } = await sb.from('companies').delete().eq('id', id); if (error) return toast(error.message); await init(); } }

// ---------------------------------------------------------------------------
// Wizard: Agregar empresa/sede en 3 pasos (Empresa -> Sede -> Actividades).
// Al guardar se crean empresa (si aplica) + sede + actividades nuevas (si se
// escribieron) y se asignan todas las actividades marcadas a esa sede en
// site_activities, en un solo flujo.
// ---------------------------------------------------------------------------
let wizardMode = 'company'; // 'company' (empresa nueva) | 'site' (sede nueva en empresa existente)
let wizardStep = 1;
let wizardSelectedActivityIds = new Set();
let wizardNewActivities = [];

function openCompanyWizard() {
  wizardMode = 'company'; wizardSelectedActivityIds = new Set(); wizardNewActivities = [];
  $('wizardTitle').textContent = 'Agregar empresa';
  $('wizStepCompanyNew').style.display = 'block';
  $('wizStepCompanyExisting').style.display = 'none';
  $('wizCompanyName').value = '';
  $('wizSiteName').value = ''; $('wizSiteHours').value = 0;
  $('wizNewActivityName').value = '';
  wizardShowStep(1);
  openModal('companyWizardModal');
}

function openSiteWizard() {
  if (!state.companies.length) return toast('Primero agrega una empresa.');
  wizardMode = 'site'; wizardSelectedActivityIds = new Set(); wizardNewActivities = [];
  $('wizardTitle').textContent = 'Agregar sede';
  $('wizStepCompanyNew').style.display = 'none';
  $('wizStepCompanyExisting').style.display = 'block';
  $('wizCompanySelect').innerHTML = options(state.companies);
  $('wizCompanySelect').value = company()?.id || state.companies[0].id;
  $('wizSiteName').value = ''; $('wizSiteHours').value = 0;
  $('wizNewActivityName').value = '';
  wizardShowStep(1);
  openModal('companyWizardModal');
}

function wizardShowStep(n) {
  wizardStep = n;
  [1, 2, 3].forEach(i => $('wizardPane' + i).style.display = i === n ? 'block' : 'none');
  document.querySelectorAll('.wizardStep').forEach(el => el.classList.toggle('active', Number(el.dataset.step) === n));
  $('wizBackBtn').style.display = n > 1 ? 'inline-block' : 'none';
  $('wizNextBtn').textContent = n === 3 ? 'Guardar' : 'Siguiente';
  if (n === 3) renderWizardActivities();
}

function renderWizardActivities() {
  const existing = state.activities.map(a => `
    <label class="wizActivityRow">
      <input type="checkbox" value="${a.id}" ${wizardSelectedActivityIds.has(a.id) ? 'checked' : ''} onchange="wizardToggleActivity('${a.id}', this.checked)">
      ${a.name}
    </label>`).join('');
  const fresh = wizardNewActivities.map((name, i) => `
    <label class="wizActivityRow wizActivityNew">
      <input type="checkbox" checked disabled> ${name} <span class="small">(nueva)</span>
      <button type="button" class="linklike" onclick="wizardRemoveNewActivity(${i})">quitar</button>
    </label>`).join('');
  $('wizActivitiesList').innerHTML = existing + fresh || '<p class="small">Todavía no hay actividades en el catálogo. Escribe una abajo para crearla.</p>';
}
function wizardToggleActivity(id, checked) { checked ? wizardSelectedActivityIds.add(id) : wizardSelectedActivityIds.delete(id); }
function wizardAddNewActivity() {
  const n = $('wizNewActivityName').value.trim();
  if (!n) return toast('Escribe el nombre de la actividad');
  wizardNewActivities.push(n);
  $('wizNewActivityName').value = '';
  renderWizardActivities();
}
function wizardRemoveNewActivity(i) { wizardNewActivities.splice(i, 1); renderWizardActivities(); }

function wizardBack() { if (wizardStep > 1) wizardShowStep(wizardStep - 1); }

async function wizardNext() {
  if (wizardStep === 1) {
    if (wizardMode === 'company') {
      if (!$('wizCompanyName').value.trim()) return toast('Ingresa el nombre de la empresa');
    } else if (!$('wizCompanySelect').value) {
      return toast('Selecciona una empresa');
    }
    return wizardShowStep(2);
  }
  if (wizardStep === 2) {
    if (!$('wizSiteName').value.trim()) return toast('Ingresa el nombre de la sede');
    return wizardShowStep(3);
  }
  await wizardSave();
}

async function wizardSave() {
  const btn = $('wizNextBtn'); btn.disabled = true; const originalText = btn.textContent; btn.textContent = 'Guardando…';
  try {
    let companyId;
    if (wizardMode === 'company') {
      const { data, error } = await sb.from('companies').insert({ name: $('wizCompanyName').value.trim() }).select('id').single();
      if (error) return toast(error.message);
      companyId = data.id;
    } else {
      companyId = $('wizCompanySelect').value;
    }

    const { data: siteData, error: siteError } = await sb.from('sites').insert({ company_id: companyId, name: $('wizSiteName').value.trim() }).select('id').single();
    if (siteError) return toast(siteError.message);
    const siteId = siteData.id;

    const hoursAssigned = Number($('wizSiteHours').value || 0);
    if (hoursAssigned > 0) {
      await sb.from('monthly_bags').insert({ site_id: siteId, month: `${monthNow()}-01`, assigned_hours: hoursAssigned, assigned_date: today(), created_by: currentProfile?.id });
    }

    const allActivityIds = new Set(wizardSelectedActivityIds);
    for (const name of wizardNewActivities) {
      const { data: actData, error: actError } = await sb.from('activities').insert({ name, is_fixed: false }).select('id').single();
      if (actError) { toast(`No se pudo crear la actividad "${name}": ${actError.message}`); continue; }
      allActivityIds.add(actData.id);
    }

    if (allActivityIds.size > 0) {
      const rows = [...allActivityIds].map(activity_id => ({ site_id: siteId, activity_id, created_by: currentProfile?.id }));
      const { error: linkError } = await sb.from('site_activities').insert(rows);
      if (linkError) toast('Sede creada, pero hubo un problema asignando actividades: ' + linkError.message);
    }

    closeModal('companyWizardModal');
    await init();
    toast('Listo: empresa, sede y actividades guardadas.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
}

// ---------------------------------------------------------------------------
// Editar actividades de una sede ya existente: permite marcar/desmarcar
// actividades del catálogo (o crear una nueva) sin tener que volver a pasar
// por el wizard de creación. Las horas asignadas del mes se editan aparte,
// con el botón "Asignar" que ya existe en esta misma tabla.
// ---------------------------------------------------------------------------
let saSiteId = null, saCompanyId = null;
let saSelectedActivityIds = new Set();
let saNewActivities = [];

function openSiteActivitiesModal(cid, sid) {
  const c = state.companies.find(x => x.id === cid), s = c?.sites.find(x => x.id === sid);
  if (!c || !s) return toast('Selecciona una empresa y sede válida');
  saCompanyId = cid; saSiteId = sid;
  saSelectedActivityIds = new Set(state.siteActivities.filter(sa => sa.site_id === sid).map(sa => sa.activity_id));
  saNewActivities = [];
  $('saSiteLabel').textContent = `${c.name} — ${s.name}`;
  $('saNewActivityName').value = '';
  renderSiteActivitiesEditor();
  openModal('siteActivitiesModal');
}

function renderSiteActivitiesEditor() {
  const existing = state.activities.map(a => {
    const hrs = taskHours(saSiteId, a.id);
    return `<label class="wizActivityRow">
      <input type="checkbox" value="${a.id}" ${saSelectedActivityIds.has(a.id) ? 'checked' : ''} onchange="saToggleActivity('${a.id}', this.checked)">
      ${a.name}${hrs > 0 ? `<span class="small" style="margin-left:6px">(${hrs} h registradas)</span>` : ''}
    </label>`;
  }).join('');
  const fresh = saNewActivities.map((name, i) => `
    <label class="wizActivityRow wizActivityNew">
      <input type="checkbox" checked disabled> ${name} <span class="small">(nueva)</span>
      <button type="button" class="linklike" onclick="saRemoveNewActivity(${i})">quitar</button>
    </label>`).join('');
  $('saActivitiesList').innerHTML = existing + fresh || '<p class="small">Todavía no hay actividades en el catálogo. Escribe una abajo para crearla.</p>';
}

function saToggleActivity(id, checked) { checked ? saSelectedActivityIds.add(id) : saSelectedActivityIds.delete(id); }

function saAddNewActivity() {
  const n = $('saNewActivityName').value.trim();
  if (!n) return toast('Escribe el nombre de la actividad');
  saNewActivities.push(n);
  $('saNewActivityName').value = '';
  renderSiteActivitiesEditor();
}
function saRemoveNewActivity(i) { saNewActivities.splice(i, 1); renderSiteActivitiesEditor(); }

async function saveSiteActivities() {
  const btn = $('saSaveBtn'); btn.disabled = true; const originalText = btn.textContent; btn.textContent = 'Guardando…';
  try {
    const currentIds = new Set(state.siteActivities.filter(sa => sa.site_id === saSiteId).map(sa => sa.activity_id));
    const finalIds = new Set(saSelectedActivityIds);

    for (const name of saNewActivities) {
      const { data: actData, error: actError } = await sb.from('activities').insert({ name, is_fixed: false }).select('id').single();
      if (actError) { toast(`No se pudo crear la actividad "${name}": ${actError.message}`); continue; }
      finalIds.add(actData.id);
    }

    const toAdd = [...finalIds].filter(id => !currentIds.has(id));
    const toRemove = [...currentIds].filter(id => !finalIds.has(id));

    const removingWithHours = toRemove.filter(id => taskHours(saSiteId, id) > 0);
    if (removingWithHours.length) {
      const names = removingWithHours.map(id => state.activities.find(a => a.id === id)?.name || 'Actividad').join(', ');
      if (!confirm(`Vas a quitar de esta sede: ${names}. Ya tienen horas registradas — ese historial se conserva, pero la actividad dejará de aparecer en esta sede. ¿Continuar?`)) {
        return;
      }
    }

    if (toAdd.length) {
      const { error } = await sb.from('site_activities').insert(toAdd.map(activity_id => ({ site_id: saSiteId, activity_id, created_by: currentProfile?.id })));
      if (error) return toast('No se pudo agregar alguna actividad: ' + error.message);
    }
    if (toRemove.length) {
      const { error } = await sb.from('site_activities').delete().eq('site_id', saSiteId).in('activity_id', toRemove);
      if (error) return toast('No se pudo quitar alguna actividad: ' + error.message);
    }

    closeModal('siteActivitiesModal');
    await init();
    toast('Actividades de la sede actualizadas.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
}

async function openMonthlyBagModal(cid, sid, m) {
  const c = cid ? state.companies.find(x => x.id === cid) : company(), s = sid ? c?.sites.find(x => x.id === sid) : site(), month = m || selectedMonth();
  if (!c || !s) return toast('Selecciona una empresa y sede');
  $('mbCompanyName').value = c.name; $('mbSiteName').value = s.name; $('mbMonth').value = month; $('mbDate').value = today();
  const { data } = await sb.from('monthly_bags').select('assigned_hours,reason').eq('site_id', s.id).eq('month', `${month}-01`).maybeSingle();
  $('mbHours').value = data?.assigned_hours || 0; $('mbReason').value = data?.reason || '';
  $('monthlyBagModal').dataset.companyId = c.id; $('monthlyBagModal').dataset.siteId = s.id;
  const prevMonth = new Date(month + '-01T00:00:00'); prevMonth.setMonth(prevMonth.getMonth() - 1);
  const prevKey = prevMonth.toISOString().slice(0, 7);
  const { data: bagData } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${prevKey}-01` });
  const carry = (bagData && bagData[0]?.remaining) || 0;
  $('mbInfo').textContent = `Saldo que llega automáticamente desde ${prevKey}: ${carry} h. La asignación mensual debe registrarse idealmente dentro de los primeros 5 días.`;
  openModal('monthlyBagModal');
}
async function saveMonthlyBag() {
  const amount = Number($('mbHours').value || 0), month = $('mbMonth').value, date = $('mbDate').value;
  if (!month || !date) return toast('Selecciona el mes y la fecha de asignación');
  const siteId = $('monthlyBagModal').dataset.siteId;
  const { error } = await sb.from('monthly_bags').upsert({
    site_id: siteId, month: `${month}-01`, assigned_hours: amount, assigned_date: date,
    reason: $('mbReason').value || 'Asignación mensual', created_by: currentProfile?.id,
  }, { onConflict: 'site_id,month' });
  if (error) return toast('No se pudo guardar: ' + error.message);
  if (Number(date.slice(-2)) > 5) toast('Aviso: esta asignación quedó registrada después de los primeros 5 días.');
  closeModal('monthlyBagModal'); await refreshAll(); toast(`Bolsa de ${month} asignada correctamente.`);
}
function openAdditionalHoursModal(cid, sid, m) {
  const c = cid ? state.companies.find(x => x.id === cid) : company(), s = sid ? c?.sites.find(x => x.id === sid) : site(), month = m || selectedMonth();
  if (!c || !s) return toast('Selecciona una empresa y sede');
  $('addCompanyName').value = c.name; $('addSiteName').value = `${s.name} · ${month}`; $('addHoursAmount').value = ''; $('addHoursReason').value = '';
  $('addHoursModal').dataset.companyId = c.id; $('addHoursModal').dataset.siteId = s.id; $('addHoursModal').dataset.month = month; openModal('addHoursModal');
}
async function saveAdditionalHours() {
  const amount = Number($('addHoursAmount').value); if (!amount || amount <= 0) return toast('Ingresa una cantidad válida de horas');
  const siteId = $('addHoursModal').dataset.siteId, m = $('addHoursModal').dataset.month;
  let { data: bag } = await sb.from('monthly_bags').select('id').eq('site_id', siteId).eq('month', `${m}-01`).maybeSingle();
  if (!bag) {
    const { data: created, error } = await sb.from('monthly_bags').insert({ site_id: siteId, month: `${m}-01`, assigned_hours: 0, created_by: currentProfile?.id }).select('id').single();
    if (error) return toast(error.message);
    bag = created;
  }
  const { error } = await sb.from('bag_adjustments').insert({ monthly_bag_id: bag.id, hours: amount, reason: $('addHoursReason').value || 'Ampliación de bolsa', created_by: currentProfile?.id });
  if (error) return toast(error.message);
  closeModal('addHoursModal'); await refreshAll(); toast(`Se agregaron ${amount} h adicionales a ${m}.`);
}
async function removeSite(cid, sid) { const c = state.companies.find(x => x.id === cid); if (c.sites.length <= 1) return toast('La empresa debe conservar al menos una sede'); if (confirm('¿Eliminar sede?')) { const { error } = await sb.from('sites').delete().eq('id', sid); if (error) return toast(error.message); await init(); } }
async function updateRate() { const v = Number($('globalRate').value || 0); const { error } = await sb.from('app_settings').upsert({ key: 'default_rate', value: v }); if (error) return toast(error.message); state.rate = v; toast('Tarifa actualizada'); }
async function addTaskPrompt() { const n = prompt('Nombre de la nueva actividad:'); if (!n?.trim()) return; const { error } = await sb.from('activities').insert({ name: n.trim(), is_fixed: false }); if (error) return toast(error.message); await init(); toast('Actividad agregada'); }

document.addEventListener('click', e => { if (window.innerWidth <= 900 && e.target.closest('.nav a')) toggleMobileMenu(false); });
function toggleMobileMenu(force) {
  const sidebar = document.querySelector('.sidebar');
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  $('sidebarBackdrop').style.display = open ? 'block' : 'none';
}
const originalShowSection = showSection;
showSection = function (id, el) {
  originalShowSection(id, el);
  document.querySelectorAll('.mtab').forEach(a => a.classList.toggle('active', a.dataset.tab === id));
  if (window.innerWidth <= 900) toggleMobileMenu(false);
  // El calendario visual (FullCalendar) no se crea mientras la sección
  // "Calendario" está oculta (ver renderFullCalendar en calendarView.js):
  // si se creara oculto, quedaría con las columnas del mes colapsadas para
  // siempre. Por eso, la primera vez que el usuario entra a esta sección,
  // la creamos recién aquí; si ya existe, solo recalculamos el tamaño por
  // si el ancho de la ventana cambió mientras estaba oculta.
  if (id === 'calendario' && typeof renderFullCalendar === 'function') {
    setTimeout(() => {
      if (typeof fullCalendarInstance !== 'undefined' && fullCalendarInstance) fullCalendarInstance.updateSize();
      else renderFullCalendar();
    }, 50);
  }
};
