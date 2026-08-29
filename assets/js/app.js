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

function taskStatus(siteId, activityId) { return state.statusMap[`${siteId}|${activityId}`] || 'Pendiente'; }
function taskIsCompleted(siteId, activityId) { return taskStatus(siteId, activityId) === 'Completada'; }
function taskHours(siteId, activityId) { return state.hoursSite.filter(h => h.site_id === siteId && h.activity_id === activityId).reduce((a, x) => a + Number(x.hours), 0); }
function taskMonthHours(siteId, activityId, m) { return state.hoursSite.filter(h => h.site_id === siteId && h.activity_id === activityId && monthOf(h.record_date) === m).reduce((a, x) => a + Number(x.hours), 0); }

// ---------------------------------------------------------------------------
// Carga inicial (catálogo) y refresco (datos operativos por filtro)
// ---------------------------------------------------------------------------
async function init() {
  // Las 3 consultas de catálogo son independientes entre sí: se piden en
  // paralelo (antes iban una detrás de otra) para que el primer ingreso a
  // la plataforma no tarde la suma de las 3, sino solo la más lenta.
  const [{ data: companies }, { data: activities }, { data: rateRow }] = await Promise.all([
    sb.from('companies').select('id,name,sites(id,name)').order('name'),
    sb.from('activities').select('id,name,is_fixed').order('is_fixed', { ascending: false }).order('name'),
    sb.from('app_settings').select('value').eq('key', 'default_rate').maybeSingle(),
  ]);
  state.companies = (companies || []).map(c => ({ ...c, sites: c.sites || [] }));
  state.activities = activities || [];
  if (rateRow) state.rate = Number(rateRow.value);

  $('filterMonth').value = monthNow();
  if ($('calendarDate')) $('calendarDate').value = today();
  $('filterCompany').innerHTML = options(state.companies);
  refreshSitesFilter();
  if ($('reportMonth')) $('reportMonth').value = selectedMonth();
  await refreshAll();
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
  if (!s) return;

  // Las 7 consultas de esta sección tampoco dependen unas de otras, así que
  // también van todas en paralelo (se agregó aquí la de "monthly_bags" que
  // antes se pedía aparte, después de esperar todo lo anterior).
  const [{ data: hours }, { data: evid }, { data: cal }, { data: statusRows }, { data: bagRow }, { data: targetRows }, { count }] = await Promise.all([
    sb.from('hour_records').select('*').eq('site_id', s.id),
    sb.from('evidences').select('*').eq('site_id', s.id).order('record_date', { ascending: false }),
    sb.from('schedule_events').select('*').eq('site_id', s.id),
    sb.from('v_activity_current_status').select('*').eq('site_id', s.id),
    sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${selectedMonth()}-01` }),
    sb.from('activity_targets').select('activity_id,target_hours').eq('site_id', s.id),
    sb.from('monthly_bags').select('id', { count: 'exact', head: true }).eq('site_id', s.id).eq('month', `${selectedMonth()}-01`),
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

  renderBagAlert();
  renderDashboard();
  renderActivities();
  renderHours();
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
  const s = site(), m = selectedMonth(), bag = state.bag;
  const hs = filteredHours(), value = hs.reduce((a, x) => a + Number(x.hours) * Number(x.rate), 0);
  $('mAssigned').textContent = bag.total + ' h';
  $('mUsed').textContent = bag.used + ' h';
  $('mRemaining').textContent = bag.remaining + ' h';
  $('mValue').textContent = money(value);
  document.querySelector('#mAssigned').parentElement.querySelector('.sub').textContent = `Asignadas: ${bag.assigned} h · Saldo anterior: ${bag.carry} h · Adicionales: ${bag.additional} h`;
  document.querySelector('#mRemaining').parentElement.querySelector('.sub').textContent = `Disponible para ${m}`;

  $('dashboardActivities').innerHTML = state.activities.map((t, i) => {
    const status = taskStatus(s.id, t.id), completed = status === 'Completada';
    const totalH = taskHours(s.id, t.id), monthH = taskMonthHours(s.id, t.id, m);
    const btn = completed
      ? `<button class="secondary" disabled style="opacity:.55;cursor:not-allowed">✓ Completada</button>`
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
  }).join('');

  const rec = [...filteredHours()].sort((a, b) => b.record_date.localeCompare(a.record_date)).slice(0, 5);
  $('recentRecords').innerHTML = rec.length ? rec.map(x => `<div style="padding:9px 0;border-bottom:1px solid var(--line)"><b>${x.record_date}</b><div class="small">${taskName(x.activity_id)} · ${x.hours} h · ${x.status}</div></div>`).join('') : '<div class="empty">Aún no hay registros en este periodo.</div>';
}

function renderActivities() {
  const s = site(), m = selectedMonth();
  $('activitiesList').innerHTML = state.activities.map((t, i) => {
    const status = taskStatus(s.id, t.id), completed = status === 'Completada';
    const totalH = taskHours(s.id, t.id), monthH = taskMonthHours(s.id, t.id, m);
    return `<div class="activity">
      <div class="activityTop">
        <div class="activityIcon ${actColor(i)}">${actIcon(i)}</div>
        <div><h3>${t.name}</h3><div class="small">${completed ? 'Actividad completada y bloqueada para nuevos registros.' : 'Sin cierre todavía.'}</div></div>
        <div>${completed ? '<span class="badge done">Completada</span>' : `<button class="secondary" data-requires-write onclick="openActivityModal('${t.id}')">Registrar horas</button>`}</div>
      </div>
      <div class="small" style="margin:8px 0"><b>${totalH} h acumuladas</b> · ${monthH} h en el mes seleccionado</div>
      ${activityProgressBar(s.id, t.id, totalH)}
      <span class="badge ${completed ? 'done' : status === 'En proceso' ? 'progress' : 'pending'}">${status}</span>
    </div>`;
  }).join('');
}

function renderHours() {
  const s = site(), rows = state.hoursSite.filter(x => x.site_id === s.id).sort((a, b) => b.record_date.localeCompare(a.record_date));
  $('hoursTable').innerHTML = rows.length ? rows.map(x => `<tr><td>${x.record_date}</td><td>${company().name}<br><span class="small">${s.name}</span></td><td>${taskName(x.activity_id)}</td><td><span class="badge ${x.status === 'Completado' ? 'done' : 'progress'}">${x.status}</span></td><td>${x.hours}</td><td>${money(x.rate)}</td><td>${money(x.hours * x.rate)}</td><td><button class="badge ${x.paid ? 'paid' : 'unpaid'}" data-requires-write onclick="togglePaid('${x.id}',${!x.paid})">${x.paid ? '✓ Pagado' : '⏳ Pendiente'}</button></td><td><button class="danger" data-requires-write onclick="deleteItem('hour_records','${x.id}')">Eliminar</button></td></tr>`).join('') : `<tr><td colspan="9" class="empty">No hay horas registradas.</td></tr>`;
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
  $('hTask').innerHTML = state.activities.map(t => `<option value="${t.id}" ${s && taskIsCompleted(s.id, t.id) ? 'disabled' : ''}>${t.name}${s && taskIsCompleted(s.id, t.id) ? ' — COMPLETADA' : ''}</option>`).join('');
}
function openHoursModal() {
  fillCommon('hCompany', 'hSite', 'hTask'); $('hCompany').value = company().id; fillSiteSelect('hCompany', 'hSite'); $('hSite').value = site().id;
  $('hDate').value = today(); $('hRate').value = state.rate; $('hHours').value = ''; $('hStatus').value = 'En proceso'; $('hTotal').value = ''; $('hNotes').value = '';
  refreshHourTaskOptions(); updateHoursBagInfo(); openModal('hoursModal');
}
$('hHours')?.addEventListener('input', () => { $('hTotal').value = money(Number($('hHours').value || 0) * state.rate); });
$('hDate')?.addEventListener('change', updateHoursBagInfo);
$('hCompany')?.addEventListener('change', () => { fillSiteSelect('hCompany', 'hSite'); refreshHourTaskOptions(); updateHoursBagInfo(); });
$('hSite')?.addEventListener('change', () => { refreshHourTaskOptions(); updateHoursBagInfo(); });

async function saveHours() {
  const h = Number($('hHours').value); if (!h || h <= 0) return toast('Ingresa una cantidad válida de horas');
  const c = state.companies.find(x => x.id === $('hCompany').value), s = c?.sites.find(x => x.id === $('hSite').value), taskId = $('hTask').value, m = monthOf($('hDate').value);
  if (!s) return toast('Selecciona una sede válida');
  if (taskIsCompleted(s.id, taskId)) return toast('Esta actividad ya está completada y no admite más horas.');
  const { data: bagData } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
  const available = (bagData && bagData[0]?.remaining) || 0;
  if (h > available) { toast(`Para ${m} solo quedan ${available} h en la bolsa. Puedes agregar horas adicionales al mes.`); closeModal('hoursModal'); openAdditionalHoursModal(c.id, s.id, m); return; }
  const status = $('hStatus').value;
  const { error } = await sb.from('hour_records').insert({
    company_id: c.id, site_id: s.id, activity_id: taskId, record_date: $('hDate').value,
    hours: h, rate: state.rate, status, notes: $('hNotes').value,
    created_by: currentProfile?.id,
  });
  if (error) return toast('No se pudo guardar: ' + error.message);
  closeModal('hoursModal'); await refreshAll();
  toast(status === 'Completado' ? 'Horas registradas y actividad cerrada.' : 'Horas registradas. La actividad queda abierta para nuevos días.');
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
  return state.activities.map(t => {
    const completed = taskIsCompleted(siteId, t.id);
    const sel = t.id === selectedId ? 'selected' : '';
    return `<option value="${t.id}" ${completed ? 'disabled' : ''} ${sel}>${t.name}${completed ? ' — COMPLETADA' : ''}</option>`;
  }).join('');
}
// Primera actividad NO completada de la sede (o la primera de todas si están todas completadas).
function firstOpenActivity(siteId) {
  const open = state.activities.find(t => !taskIsCompleted(siteId, t.id));
  return open ? open.id : (state.activities[0]?.id || null);
}
function openActivityModal(taskId) {
  $('aCompany').innerHTML = options(state.companies); $('aCompany').value = company().id;
  fillSiteSelect('aCompany', 'aSite'); $('aSite').value = site().id;
  const s = site();
  if (!s) return;
  if (state.activities.every(t => taskIsCompleted(s.id, t.id))) { toast('Todas las actividades de esta sede ya están completadas.'); return; }
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
function openEvidenceModal() { fillCommon('eCompany', 'eSite', 'eTask'); $('eCompany').value = company().id; fillSiteSelect('eCompany', 'eSite'); $('eSite').value = site().id; $('eDate').value = today(); $('eLink').value = ''; $('eDesc').value = ''; $('eFile').value = ''; openModal('evidenceModal'); }
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
  $('cfg-companies').innerHTML = `<div class="panelhead"><h2>Empresas</h2><button class="primary" data-requires-write onclick="openModal('companyModal')">+ Agregar empresa</button></div><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sedes</th><th></th></tr></thead><tbody>${state.companies.map(c => `<tr><td>${c.name}</td><td>${c.sites.length}</td><td><button class="danger" data-requires-write onclick="removeCompany('${c.id}')">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`;

  const rows = [];
  for (const c of state.companies) {
    for (const s of c.sites) {
      const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
      const b = (data && data[0]) || { assigned: 0, carry: 0, additional: 0, used: 0, remaining: 0 };
      rows.push(`<tr><td>${c.name}</td><td>${s.name}</td><td>${b.assigned} h</td><td>${b.carry} h</td><td>${b.additional} h</td><td>${b.used} h</td><td><b>${b.remaining} h</b></td><td><button class="primary" data-requires-write onclick="openMonthlyBagModal('${c.id}','${s.id}','${m}')">Asignar</button> <button class="success" data-requires-write onclick="openAdditionalHoursModal('${c.id}','${s.id}','${m}')">+ Horas</button> <button class="danger" data-requires-write onclick="removeSite('${c.id}','${s.id}')">Eliminar</button></td></tr>`);
    }
  }
  $('cfg-sites').innerHTML = `<div class="panelhead"><h2>Bolsas mensuales de horas</h2><div><button class="success" data-requires-write onclick="openMonthlyBagModal()">+ Asignar bolsa del mes</button> <button class="primary" data-requires-write onclick="openSiteModal()">+ Agregar sede</button></div></div><p class="small">Periodo mostrado: <b>${m}</b>. El saldo no utilizado del mes anterior se suma automáticamente como saldo a favor.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Asignadas</th><th>Saldo anterior</th><th>Adicionales</th><th>Usadas</th><th>Disponibles</th><th>Acción</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  $('cfg-rates').innerHTML = `<div class="panelhead"><h2>Tarifa de referencia</h2></div><div class="formgrid"><div><label>Valor por hora (COP)</label><input id="globalRate" type="number" value="${state.rate}"></div></div><div class="actions"><button class="primary" data-requires-write onclick="updateRate()">Guardar tarifa</button></div><p class="small">La tarifa configurada se propone para nuevos registros. Cada registro conserva su propia tarifa.</p>`;
  $('cfg-tasks').innerHTML = `<div class="panelhead"><h2>Actividades del proyecto</h2><button class="primary" data-requires-write onclick="addTaskPrompt()">+ Nueva actividad</button></div>${state.activities.map(t => `<div class="activity"><b>${t.name}</b>${t.is_fixed ? '<div class="small">Actividad inicial establecida</div>' : '<div class="small">Actividad agregada</div>'}</div>`).join('')}`;
}

async function addCompany() { const n = $('newCompany').value.trim(); if (!n) return toast('Ingresa el nombre'); const { error } = await sb.from('companies').insert({ name: n }); if (error) return toast(error.message); $('newCompany').value = ''; closeModal('companyModal'); await init(); toast('Empresa agregada'); }
async function removeCompany(id) { if (state.companies.length <= 1) return toast('Debe existir al menos una empresa'); if (confirm('¿Eliminar empresa y sus sedes?')) { const { error } = await sb.from('companies').delete().eq('id', id); if (error) return toast(error.message); await init(); } }
function openSiteModal() { $('sCompany').innerHTML = options(state.companies); $('newSite').value = ''; $('newSiteHours').value = 0; openModal('siteModal'); }
async function addSite() { const c = state.companies.find(x => x.id === $('sCompany').value), n = $('newSite').value.trim(); if (!n) return toast('Ingresa la sede'); const { error } = await sb.from('sites').insert({ company_id: c.id, name: n }); if (error) return toast(error.message); closeModal('siteModal'); await init(); toast('Sede agregada. Ahora puedes asignar la bolsa del mes.'); }

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
