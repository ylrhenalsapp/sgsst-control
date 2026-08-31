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
  activityLog: [], // bitácora de acciones relevantes (empresas creadas, actividades cargadas, horas registradas)
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
// La tarifa es POR EMPRESA (no por sede ni global): cada empresa trae su
// propia companies.rate. state.rate solo queda como último recurso (empresa
// sin tarifa cargada, o ningún filtro seleccionado todavía).
function companyRate(c) { return Number(c?.rate ?? state.rate ?? 50000); }
// Mensaje para cuando no hay ninguna sede seleccionable: distingue entre "no
// tienes ninguna empresa todavía" y "esta empresa existe pero se quedó sin
// sedes" (empresa inactiva — se puede eliminar la última sede de una
// empresa sin borrar la empresa, y mientras no tenga sedes queda inactiva).
function noSiteMessage() {
  if (!state.companies.length) return 'Todavía no tienes ninguna empresa registrada. Ve a Configuración → Empresas y agrega la primera para empezar.';
  const c = company();
  return `La empresa "${c?.name || ''}" está inactiva: no tiene ninguna sede. Agrégale una sede desde Configuración → Sedes y horas para activarla.`;
}

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
    sb.from('companies').select('id,name,rate,sites(id,name)').order('name'),
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
  // Reconstruir el <select> con innerHTML borra la selección anterior (el
  // navegador vuelve a marcar la PRIMERA opción como elegida al no haber
  // ningún <option selected>). Por eso, antes de reconstruirlo, se guarda
  // qué sede tenía elegida el usuario para volver a aplicarla después —
  // si no se hacía esto, elegir la segunda sede de una empresa con varias
  // sedes se deshacía solo en cuanto refreshAll() volvía a llamar a esta
  // función (por ejemplo, disparado por el propio cambio de sede), y la
  // sede seleccionada saltaba siempre de vuelta a la primera de la lista.
  const desired = $('filterSite').value;
  $('filterSite').innerHTML = options(c ? c.sites : []);
  if (c?.sites.some(s => s.id === desired)) {
    $('filterSite').value = desired;
  } else {
    $('filterSite').selectedIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// Bitácora de actividad: registro de acciones relevantes (creación de
// empresas/sedes, carga de actividades a una sede, registro de horas) para
// mostrar un feed de "qué se ha hecho" en el Dashboard. Es de solo lectura
// desde la interfaz (nadie edita ni borra entradas, para que sirva de
// histórico confiable). Si la tabla todavía no existe en la base de datos
// (falta correr la migración) falla en silencio y el panel queda vacío, sin
// romper el resto del Dashboard.
// ---------------------------------------------------------------------------
async function logActivity(actionType, description, { companyId = null, siteId = null } = {}) {
  try {
    await sb.from('activity_log').insert({
      action_type: actionType, description, company_id: companyId, site_id: siteId, created_by: currentProfile?.id,
    });
  } catch (e) { /* la bitácora nunca debe interrumpir la acción principal */ }
}

async function refreshActivityLog() {
  try {
    const { data, error } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20);
    state.activityLog = error ? [] : (data || []);
  } catch (e) {
    state.activityLog = [];
  }
  renderActivityLog();
}

function renderActivityLog() {
  const el = $('activityLogList');
  if (!el) return;
  if (!state.activityLog.length) { el.innerHTML = '<div class="empty">Aún no hay actividad registrada.</div>'; return; }
  el.innerHTML = state.activityLog.map(r => {
    const dt = new Date(r.created_at);
    const when = isNaN(dt) ? '' : dt.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div style="padding:9px 0;border-bottom:1px solid var(--line)"><div class="small">${when}</div>${r.description}</div>`;
  }).join('');
}

async function refreshAll() {
  refreshSitesFilter();
  refreshActivityLog();
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
    if (typeof refreshCalendarShowAll === 'function') await refreshCalendarShowAll();
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
  if (typeof refreshCalendarShowAll === 'function') await refreshCalendarShowAll();
}

// ---------------------------------------------------------------------------
// Mini calendario decorativo del panel "Acciones rápidas" (solo visual, no
// interactivo: muestra el mes actual con el día de hoy resaltado). El
// calendario completo con eventos reales sigue viviendo en la sección
// "Calendario" (renderCalendar / renderFullCalendar en calendarView.js).
// ---------------------------------------------------------------------------
// Desplazamiento en meses respecto al mes actual (0 = mes de hoy, 1 = mes
// siguiente, -1 = mes anterior, etc.) — se conserva mientras la pestaña
// siga abierta; al recargar la página vuelve a mostrar el mes de hoy.
let miniCalOffset = 0;
function miniCalShift(delta) { miniCalOffset += delta; renderMiniCalendar(); }

function renderMiniCalendar() {
  const el = $('miniCalendar');
  if (!el) return;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + miniCalOffset, 1);
  const year = base.getFullYear(), month = base.getMonth();
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // El día de hoy solo se resalta cuando efectivamente se está viendo el mes
  // actual (miniCalOffset === 0); en otro mes no hay "hoy" que resaltar.
  const todayNum = miniCalOffset === 0 ? now.getDate() : -1;
  // Días de este mes con al menos una actividad programada en la agenda de
  // la sede seleccionada (state.calendarSite), para marcarlos con un punto.
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const daysWithEvents = new Set(
    (state.calendarSite || [])
      .filter(e => e.event_date && e.event_date.startsWith(monthPrefix))
      .map(e => Number(e.event_date.slice(8, 10)))
  );
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<span class="miniCalDay empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const cls = ['miniCalDay'];
    if (d === todayNum) cls.push('today');
    if (daysWithEvents.has(d)) cls.push('hasEvent');
    cells += `<span class="${cls.join(' ')}">${d}</span>`;
  }
  el.innerHTML = `
    <div class="miniCalHead">
      <button class="miniCalNav" onclick="miniCalShift(-1)" title="Mes anterior">‹</button>
      <span>${monthNames[month]} ${year}</span>
      <button class="miniCalNav" onclick="miniCalShift(1)" title="Mes siguiente">›</button>
    </div>
    <div class="miniCalGrid miniCalGridHead">
      <span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span>
    </div>
    <div class="miniCalGrid">${cells}</div>`;
}

function activityTarget(siteId, activityId) { return state.targetsMap[`${siteId}|${activityId}`] || null; }
function activityProgressBar(siteId, activityId, totalH) {
  const target = activityTarget(siteId, activityId);
  // Sin una meta de horas configurada no hay contra qué calcular un %; se
  // avisa explícitamente en vez de dejar el espacio vacío (antes parecía
  // que el porcentaje simplemente no existía). La meta se define desde
  // Configuración → Sedes y horas → "Actividades".
  if (!target) return '<span class="small">Sin meta de horas definida</span>';
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
// Actualiza el aro circular "Avance de horas del mes" (horas ejecutadas vs
// asignadas de la bolsa de la sede seleccionada). Cambia de color según el
// porcentaje: verde normal, ámbar cerca del límite, rojo si ya se llegó al 100%.
function updateMonthProgressRadial(used, total) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const CIRC = 326.7256; // 2 * PI * 52 (radio del <circle> del SVG)
  const bar = $('radialProgressBar');
  if (bar) {
    bar.style.strokeDashoffset = String(CIRC * (1 - pct / 100));
    bar.style.stroke = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)';
  }
  if ($('radialProgressPct')) $('radialProgressPct').textContent = pct + '%';
  if ($('radialProgressSub')) $('radialProgressSub').textContent = `${used} h ejecutadas de ${total} h asignadas`;
}

function renderDashboard() {
  const s = site();
  if (!s) {
    $('mAssigned').textContent = '0 h'; $('mUsed').textContent = '0 h'; $('mRemaining').textContent = '0 h'; $('mValue').textContent = money(0);
    document.querySelector('#mAssigned').parentElement.querySelector('.sub').textContent = 'Asignadas: 0 h · Saldo anterior: 0 h · Adicionales: 0 h';
    document.querySelector('#mRemaining').parentElement.querySelector('.sub').textContent = `Disponible para ${selectedMonth()}`;
    document.querySelector('#mValue').parentElement.querySelector('.sub').textContent = 'Tarifa vigente por hora';
    $('dashboardActivities').innerHTML = `<p class="empty">${noSiteMessage()}</p>`;
    updateMonthProgressRadial(0, 0);
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
  document.querySelector('#mValue').parentElement.querySelector('.sub').textContent = `Tarifa de ${company()?.name || 'la empresa'}: ${money(companyRate(company()))}/h`;
  updateMonthProgressRadial(bag.used, bag.total);

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
}

function renderActivities() {
  const s = site();
  if (!s) { $('activitiesList').innerHTML = `<p class="empty">${noSiteMessage()}</p>`; return; }
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
  if (!s) { $('hoursTable').innerHTML = `<tr><td colspan="10" class="empty">${noSiteMessage()}</td></tr>`; return; }
  const rows = state.hoursSite.filter(x => x.site_id === s.id).sort((a, b) => b.record_date.localeCompare(a.record_date));
  $('hoursTable').innerHTML = rows.length ? rows.map(x => {
    const closed = monthClosed(s.id, monthOf(x.record_date));
    const editBtn = closed
      ? `<span class="small" title="El mes de este registro ya está cerrado">🔒 Cerrado</span>`
      : `<button class="secondary" data-requires-write onclick="editHours('${x.id}')">Editar</button>`;
    // El % de avance es de la ACTIVIDAD completa en esta sede (horas
    // acumuladas de todos sus registros / meta configurada), no solo de
    // este registro puntual — por eso se repite en cada fila de la misma
    // actividad, igual que en Dashboard y Actividades.
    const avance = activityProgressBar(s.id, x.activity_id, taskHours(s.id, x.activity_id));
    return `<tr><td>${x.record_date}</td><td>${company().name}<br><span class="small">${s.name}</span></td><td>${taskName(x.activity_id)}</td><td>${avance}</td><td><span class="badge ${x.status === 'Completado' ? 'done' : 'progress'}">${x.status}</span></td><td>${x.hours}</td><td>${money(x.rate)}</td><td>${money(x.hours * x.rate)}</td><td><button class="badge ${x.paid ? 'paid' : 'unpaid'}" data-requires-write onclick="togglePaid('${x.id}',${!x.paid})">${x.paid ? '✓ Pagado' : '⏳ Pendiente'}</button></td><td style="white-space:nowrap">${editBtn} <button class="danger" data-requires-write onclick="deleteItem('hour_records','${x.id}')">Eliminar</button></td></tr>`;
  }).join('') : `<tr><td colspan="10" class="empty">No hay horas registradas.</td></tr>`;
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
  // El calendario visual (FullCalendar) solo puede crearse una vez su
  // contenedor ya es visible (si se crea oculto, mide ancho 0 y las columnas
  // quedan colapsadas para siempre). Antes esto dependía de que refreshAll()
  // se ejecutara justo mientras la sección "Calendario" ya estaba activa —
  // casi nunca pasaba navegando normalmente desde el Dashboard — así que las
  // actividades programadas nunca llegaban a pintarse en el calendario
  // visual. Ahora se fuerza aquí mismo, justo cuando la sección se hace
  // visible, con los datos ya cargados en state.calendarSite.
  if (id === 'calendario' && typeof renderFullCalendar === 'function') renderFullCalendar();
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
  $('hDate').value = today(); $('hRate').value = companyRate(company()); $('hHours').value = ''; $('hStatus').value = 'En proceso'; $('hTotal').value = ''; $('hNotes').value = '';
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
$('hHours')?.addEventListener('input', () => { const c = state.companies.find(x => x.id === $('hCompany').value); $('hTotal').value = money(Number($('hHours').value || 0) * Number($('hRate').value || companyRate(c))); });
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
      hours: h, rate: Number($('hRate').value) || companyRate(c), status, notes: $('hNotes').value,
    }).eq('id', editingHourId));
  } else {
    ({ error } = await sb.from('hour_records').insert({
      company_id: c.id, site_id: s.id, activity_id: taskId, record_date: $('hDate').value,
      hours: h, rate: Number($('hRate').value) || companyRate(c), status, notes: $('hNotes').value,
      created_by: currentProfile?.id,
    }));
  }
  if (error) return toast('No se pudo guardar: ' + error.message);
  editingHourId = null;
  logActivity('hours_registered', wasEditing
    ? `Se editaron horas de "${taskName(taskId)}" (${s.name}): ahora ${h} h el ${$('hDate').value}.`
    : `Se registraron ${h} h en "${taskName(taskId)}" (${s.name}) el ${$('hDate').value}.`, { companyId: c.id, siteId: s.id });
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
    // hour_records.status solo admite 'En proceso' / 'Completado' (igual que
    // el otro flujo de registro de horas) — 'Pendiente' es un estado válido
    // para la actividad en sí (sin horas), pero nunca para un registro de
    // horas ya ejecutadas, así que aquí se normaliza antes de insertar.
    const hrStatus = status === 'Completado' ? 'Completado' : 'En proceso';
    const { error } = await sb.from('hour_records').insert({
      company_id: c.id, site_id: s.id, activity_id: tid, record_date: today(),
      hours, rate: companyRate(c), status: hrStatus, notes: $('aNotes').value, source: 'avance', created_by: currentProfile?.id,
    });
    if (error) return toast('No se pudo guardar: ' + error.message);
    logActivity('hours_registered', `Se registraron ${hours} h en "${taskName(tid)}" (${s.name}) el ${today()}.`, { companyId: c.id, siteId: s.id });
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
  // Una empresa sin ninguna sede queda "inactiva" (se puede eliminar su
  // última sede sin que eso borre la empresa) — se marca aquí para que se
  // note de un vistazo que necesita una sede nueva para volver a operar.
  $('cfg-companies').innerHTML = `<div class="panelhead"><h2>Empresas</h2><button class="primary" data-requires-write onclick="openCompanyWizard()">+ Agregar empresa</button></div><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sedes</th><th>Estado</th><th></th></tr></thead><tbody>${state.companies.map(c => `<tr><td>${c.name}</td><td>${c.sites.length}</td><td>${c.sites.length ? '<span class="badge done">Activa</span>' : '<span class="badge pending" title="Sin sedes: agrega una desde Sedes y horas para activarla">Inactiva</span>'}</td><td><button class="danger" data-requires-write onclick="removeCompany('${c.id}')">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`;

  const rows = [];
  for (const c of state.companies) {
    for (const s of c.sites) {
      const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
      const b = (data && data[0]) || { assigned: 0, carry: 0, additional: 0, used: 0, remaining: 0 };
      rows.push(`<tr><td>${c.name}</td><td>${s.name}</td><td>${b.assigned} h</td><td>${b.carry} h</td><td>${b.additional} h</td><td>${b.used} h</td><td><b>${b.remaining} h</b></td><td style="white-space:nowrap"><button class="primary" data-requires-write onclick="openMonthlyBagModal('${c.id}','${s.id}','${m}')">Asignar</button> <button class="success" data-requires-write onclick="openAdditionalHoursModal('${c.id}','${s.id}','${m}')">+ Horas</button> <button class="secondary" data-requires-write onclick="openSiteActivitiesModal('${c.id}','${s.id}')">Actividades</button> <button class="danger" data-requires-write onclick="removeSite('${c.id}','${s.id}')">Eliminar</button></td></tr>`);
    }
  }
  $('cfg-sites').innerHTML = `<div class="panelhead"><h2>Bolsas mensuales de horas</h2><div><button class="success" data-requires-write onclick="openMonthlyBagModal()">+ Asignar bolsa del mes</button> <button class="primary" data-requires-write onclick="openSiteWizard()">+ Agregar sede</button></div></div><p class="small">Periodo mostrado: <b>${m}</b>. El saldo no utilizado del mes anterior se suma automáticamente como saldo a favor.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Asignadas</th><th>Saldo anterior</th><th>Adicionales</th><th>Usadas</th><th>Disponibles</th><th>Acción</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  // La tarifa es por EMPRESA, no global ni por sede: cada empresa tiene la
  // suya propia, y se propone automáticamente al registrar horas nuevas de
  // esa empresa. Cambiar esto no afecta los registros ya guardados (cada
  // uno conserva la tarifa con la que se creó).
  $('cfg-rates').innerHTML = `<div class="panelhead"><h2>Tarifas por empresa</h2></div><p class="small">Cada empresa tiene su propia tarifa por hora. Se propone para los registros nuevos de esa empresa; los ya guardados conservan la suya.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Tarifa por hora (COP)</th><th></th></tr></thead><tbody>${state.companies.length ? state.companies.map(c => `<tr><td>${c.name}</td><td><input id="rate-${c.id}" type="number" min="0" step="1000" value="${companyRate(c)}" style="width:150px"></td><td><button class="primary" data-requires-write onclick="updateCompanyRate('${c.id}')">Guardar</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">Todavía no tienes ninguna empresa registrada.</td></tr>'}</tbody></table></div>`;
  $('cfg-tasks').innerHTML = `<div class="panelhead"><h2>Actividades del proyecto</h2><button class="primary" data-requires-write onclick="addTaskPrompt()">+ Nueva actividad</button></div>${state.activities.map(t => `<div class="activity"><div class="activityTop"><div><b>${t.name}</b>${t.is_fixed ? '<div class="small">Actividad inicial establecida</div>' : '<div class="small">Actividad agregada</div>'}</div><button class="secondary" data-requires-write onclick="editTaskPrompt('${t.id}')">✏️ Editar nombre</button></div></div>`).join('')}`;
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

// Código de Postgres para "unique_violation" (ej: nombre de empresa/sede
// repetido). Se usa para que reintentar el wizard después de una falla a
// mitad de camino (por ejemplo, la empresa sí se creó pero la sede o las
// actividades fallaron) no quede bloqueado por un choque de nombres: en vez
// de fallar, se reutiliza el registro que ya existe y se continúa.
const PG_UNIQUE_VIOLATION = '23505';

async function wizardSave() {
  const btn = $('wizNextBtn'); btn.disabled = true; const originalText = btn.textContent; btn.textContent = 'Guardando…';
  try {
    let companyId, companyName, companyWasCreated = false;
    if (wizardMode === 'company') {
      companyName = $('wizCompanyName').value.trim();
      const { data, error } = await sb.from('companies').insert({ name: companyName, rate: state.rate }).select('id').single();
      if (error && error.code === PG_UNIQUE_VIOLATION) {
        const { data: existing, error: findError } = await sb.from('companies').select('id').eq('name', companyName).maybeSingle();
        if (findError || !existing) return toast('Ya existe una empresa con ese nombre, pero no se pudo recuperar: ' + (findError?.message || 'sin detalle'));
        companyId = existing.id;
        toast('Ya existía una empresa con ese nombre — se usará esa y se continúa con la sede.');
      } else if (error) {
        return toast(error.message);
      } else {
        companyId = data.id;
        companyWasCreated = true;
      }
    } else {
      companyId = $('wizCompanySelect').value;
      companyName = state.companies.find(c => c.id === companyId)?.name || '';
    }

    const siteName = $('wizSiteName').value.trim();
    let siteId, siteWasCreated = false;
    const { data: siteData, error: siteError } = await sb.from('sites').insert({ company_id: companyId, name: siteName }).select('id').single();
    if (siteError && siteError.code === PG_UNIQUE_VIOLATION) {
      const { data: existingSite, error: findSiteError } = await sb.from('sites').select('id').eq('company_id', companyId).eq('name', siteName).maybeSingle();
      if (findSiteError || !existingSite) return toast('Ya existe una sede con ese nombre, pero no se pudo recuperar: ' + (findSiteError?.message || 'sin detalle'));
      siteId = existingSite.id;
      toast('Ya existía una sede con ese nombre — se usará esa y se continúa con las actividades.');
    } else if (siteError) {
      return toast(siteError.message);
    } else {
      siteId = siteData.id;
      siteWasCreated = true;
      const hoursAssigned = Number($('wizSiteHours').value || 0);
      if (hoursAssigned > 0) {
        await sb.from('monthly_bags').insert({ site_id: siteId, month: `${monthNow()}-01`, assigned_hours: hoursAssigned, assigned_date: today(), created_by: currentProfile?.id });
      }
    }

    if (companyWasCreated) logActivity('company_created', `Se creó la empresa "${companyName}".`, { companyId });
    if (siteWasCreated) logActivity('site_created', `Se creó la sede "${siteName}" en la empresa "${companyName}".`, { companyId, siteId });

    const allActivityIds = new Set(wizardSelectedActivityIds);
    const newActivityNames = [];
    for (const name of wizardNewActivities) {
      const { data: actData, error: actError } = await sb.from('activities').insert({ name, is_fixed: false }).select('id').single();
      if (actError) { toast(`No se pudo crear la actividad "${name}": ${actError.message}`); continue; }
      allActivityIds.add(actData.id);
      newActivityNames.push(name);
    }

    if (allActivityIds.size > 0) {
      // Si la sede ya existía (retomando un intento anterior), puede que
      // alguna de estas actividades ya estuviera asignada: no la volvemos a
      // insertar para no duplicar ni fallar por eso.
      const { data: already } = await sb.from('site_activities').select('activity_id').eq('site_id', siteId);
      const alreadyIds = new Set((already || []).map(r => r.activity_id));
      const rows = [...allActivityIds].filter(id => !alreadyIds.has(id)).map(activity_id => ({ site_id: siteId, activity_id, created_by: currentProfile?.id }));
      if (rows.length) {
        const { error: linkError } = await sb.from('site_activities').insert(rows);
        if (linkError) toast('Sede creada, pero hubo un problema asignando actividades: ' + linkError.message);
        else logActivity('activities_loaded', `Se cargaron ${rows.length} actividad(es) a la sede "${siteName}" (${companyName}).`, { companyId, siteId });
      }
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
// Meta de horas por actividad PARA ESTA SEDE en particular (activityId ->
// número de horas u "" si no aplica). Una misma actividad del catálogo
// puede estar en varias sedes de la misma empresa, cada una con su propia
// meta y su propio avance — nunca es un valor global de la actividad.
let saTargetHours = {};

function openSiteActivitiesModal(cid, sid) {
  const c = state.companies.find(x => x.id === cid), s = c?.sites.find(x => x.id === sid);
  if (!c || !s) return toast('Selecciona una empresa y sede válida');
  saCompanyId = cid; saSiteId = sid;
  saSelectedActivityIds = new Set(state.siteActivities.filter(sa => sa.site_id === sid).map(sa => sa.activity_id));
  saNewActivities = [];
  saTargetHours = {};
  state.activities.forEach(a => { const t = activityTarget(sid, a.id); if (t) saTargetHours[a.id] = t; });
  $('saSiteLabel').textContent = `${c.name} — ${s.name}`;
  $('saNewActivityName').value = '';
  renderSiteActivitiesEditor();
  openModal('siteActivitiesModal');
}

function renderSiteActivitiesEditor() {
  const existing = state.activities.map(a => {
    const hrs = taskHours(saSiteId, a.id);
    const checked = saSelectedActivityIds.has(a.id);
    return `<label class="wizActivityRow">
      <input type="checkbox" value="${a.id}" ${checked ? 'checked' : ''} onchange="saToggleActivity('${a.id}', this.checked)">
      <span style="flex:1">${a.name}${hrs > 0 ? `<span class="small" style="margin-left:6px">(${hrs} h registradas)</span>` : ''}</span>
      <input type="number" min="0" step="0.5" value="${saTargetHours[a.id] || ''}" placeholder="Meta h" title="Meta de horas para esta actividad EN ESTA SEDE (opcional). Sirve para calcular el % de avance en el Dashboard, Actividades y Registro de horas. Otras sedes con la misma actividad tienen su propia meta independiente." style="width:78px" onchange="saSetTargetHours('${a.id}', this.value)">
    </label>`;
  }).join('');
  const fresh = saNewActivities.map((name, i) => `
    <label class="wizActivityRow wizActivityNew">
      <input type="checkbox" checked disabled> <span style="flex:1">${name} <span class="small">(nueva)</span></span>
      <button type="button" class="linklike" onclick="saRemoveNewActivity(${i})">quitar</button>
    </label>`).join('');
  $('saActivitiesList').innerHTML = existing + fresh || '<p class="small">Todavía no hay actividades en el catálogo. Escribe una abajo para crearla.</p>';
}

function saToggleActivity(id, checked) { checked ? saSelectedActivityIds.add(id) : saSelectedActivityIds.delete(id); }
function saSetTargetHours(id, value) {
  const n = Number(value);
  if (value === '' || !(n > 0)) delete saTargetHours[id]; else saTargetHours[id] = n;
}

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
      const c = state.companies.find(x => x.id === saCompanyId), s = c?.sites.find(x => x.id === saSiteId);
      logActivity('activities_loaded', `Se cargaron ${toAdd.length} actividad(es) a la sede "${s?.name || ''}" (${c?.name || ''}).`, { companyId: saCompanyId, siteId: saSiteId });
    }
    if (toRemove.length) {
      const { error } = await sb.from('site_activities').delete().eq('site_id', saSiteId).in('activity_id', toRemove);
      if (error) return toast('No se pudo quitar alguna actividad: ' + error.message);
    }

    // Metas de horas: solo para las actividades que quedan activas en esta
    // sede. Cada meta es exclusiva de (sede, actividad) — no afecta a otras
    // sedes que compartan la misma actividad del catálogo.
    for (const activityId of finalIds) {
      await saveActivityTarget(saSiteId, activityId, saTargetHours[activityId] || 0);
    }

    closeModal('siteActivitiesModal');
    await init();
    toast('Actividades de la sede actualizadas.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
}

// Crea, actualiza o borra la meta de horas de una actividad para UNA sede
// puntual (site_id + activity_id). No usa upsert con onConflict porque no
// se puede asumir que exista una restricción única en la tabla; en vez de
// eso, se busca el registro exacto de esta combinación y se actualiza o se
// crea según corresponda. hours <= 0 borra la meta (vuelve a "sin meta").
async function saveActivityTarget(siteId, activityId, hours) {
  const { data: existing } = await sb.from('activity_targets').select('id').eq('site_id', siteId).eq('activity_id', activityId).maybeSingle();
  if (!(hours > 0)) {
    if (existing) await sb.from('activity_targets').delete().eq('id', existing.id);
    return;
  }
  if (existing) {
    await sb.from('activity_targets').update({ target_hours: hours }).eq('id', existing.id);
  } else {
    await sb.from('activity_targets').insert({ site_id: siteId, activity_id: activityId, target_hours: hours });
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
// Una empresa SÍ puede quedarse sin ninguna sede (queda "inactiva" hasta que
// se le agregue una nueva) — a diferencia de antes, ya no se bloquea borrar
// la última sede de una empresa.
async function removeSite(cid, sid) {
  const c = state.companies.find(x => x.id === cid);
  const isLast = c && c.sites.length <= 1;
  const msg = isLast
    ? `¿Eliminar esta sede? Es la última de "${c?.name || 'la empresa'}" — al borrarla, la empresa quedará inactiva (sin sedes) hasta que le agregues una nueva desde Configuración.`
    : '¿Eliminar sede?';
  if (confirm(msg)) { const { error } = await sb.from('sites').delete().eq('id', sid); if (error) return toast(error.message); await init(); }
}
async function updateCompanyRate(id) {
  const input = $('rate-' + id);
  const v = Number(input?.value || 0);
  if (!(v > 0)) return toast('Ingresa una tarifa válida.');
  const { error } = await sb.from('companies').update({ rate: v }).eq('id', id);
  if (error) return toast('No se pudo actualizar: ' + error.message);
  const c = state.companies.find(x => x.id === id);
  if (c) c.rate = v;
  toast(`Tarifa actualizada para ${c?.name || 'la empresa'}.`);
  renderDashboard();
}
async function addTaskPrompt() { const n = prompt('Nombre de la nueva actividad:'); if (!n?.trim()) return; const { error } = await sb.from('activities').insert({ name: n.trim(), is_fixed: false }); if (error) return toast(error.message); logActivity('activities_loaded', `Se agregó la actividad "${n.trim()}" al catálogo.`); await init(); toast('Actividad agregada'); }
// Corrige el nombre de una actividad del catálogo (por ejemplo, si quedó mal
// escrita al crearla). Cambia el nombre en todas las sedes donde ya está
// asignada y en el historial de horas/evidencias/informes, que solo guardan
// el id de la actividad — no hay que reasignar nada.
async function editTaskPrompt(id) {
  const t = state.activities.find(x => x.id === id); if (!t) return;
  const n = prompt('Nuevo nombre de la actividad:', t.name);
  if (n === null) return; // canceló
  if (!n.trim()) return toast('El nombre no puede quedar vacío');
  if (n.trim() === t.name) return;
  const { error } = await sb.from('activities').update({ name: n.trim() }).eq('id', id);
  if (error) return toast('No se pudo actualizar: ' + error.message);
  await init();
  toast('Nombre de la actividad actualizado.');
}

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
