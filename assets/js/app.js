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

// Convierte un valor en pesos a su forma escrita en español, para el
// "VALOR EN LETRAS" de la Cuenta de cobro (ej. 1564000 -> "UN MILLON
// QUINIENTOS SESENTA Y CUATRO MIL PESOS M/CTE"). Cubre hasta cientos de
// millones, más que suficiente para los montos que maneja la plataforma.
function numeroALetras(valor) {
  const num = Math.round(Number(valor) || 0);
  if (num === 0) return 'CERO PESOS M/CTE';
  const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
  const ESPECIALES = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const DECENAS = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function seccion(n) { // n entre 0 y 999
    let out = '';
    const c = Math.floor(n / 100), r = n % 100;
    if (c > 0) out += (n === 100 ? 'CIEN' : CENTENAS[c]) + ' ';
    if (r > 0) {
      if (r < 10) out += UNIDADES[r];
      else if (r < 20) out += ESPECIALES[r - 10];
      else {
        const d = Math.floor(r / 10), u = r % 10;
        out += DECENAS[d] + (u > 0 ? ' Y ' + UNIDADES[u] : '');
      }
    }
    return out.trim();
  }

  const millones = Math.floor(num / 1000000);
  const miles = Math.floor((num % 1000000) / 1000);
  const resto = num % 1000;

  const partes = [];
  if (millones > 0) partes.push(millones === 1 ? 'UN MILLON' : seccion(millones) + ' MILLONES');
  if (miles > 0) partes.push(miles === 1 ? 'MIL' : seccion(miles) + ' MIL');
  if (resto > 0) partes.push(seccion(resto));

  return (partes.join(' ') + ' PESOS M/CTE').replace(/\s+/g, ' ').trim();
}

function toast(t, ms = 2800) { $('toast').textContent = t; $('toast').style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => $('toast').style.display = 'none', ms); }
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
  providers: [], // [{id,name,nit,gerente,direccion,ciudad,telefono,email_radicacion}] catálogo de proveedores (ARL, etc.) — una empresa puede no tener proveedor asignado
  advisorProfile: null, // datos fijos de Yasbleidis (cédula, profesión, cuenta bancaria...) para la Cuenta de cobro
  expensesSite: [], // viáticos/gastos de desplazamiento de la sede seleccionada (todas las fechas)
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
// La tarifa es POR PROVEEDOR cuando la empresa tiene uno asignado y ese
// proveedor tiene tarifa cargada (todas las empresas de ese proveedor
// cobran igual — migración 0018). Si la empresa no tiene proveedor, o su
// proveedor todavía no tiene tarifa propia, se usa la tarifa de la empresa
// (companies.rate) como antes. state.rate solo queda como último recurso.
function providerRateFor(c) {
  const p = c?.provider_id ? state.providers.find(x => x.id === c.provider_id) : null;
  return (p && Number(p.rate) > 0) ? Number(p.rate) : null;
}
function companyRate(c) { return providerRateFor(c) ?? Number(c?.rate ?? state.rate ?? 50000); }
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

// ---------------------------------------------------------------------------
// Resumen general (todas las empresas/sedes juntas, no solo la seleccionada).
// Usado por el panel del Dashboard y por el "Informe general" de Informes.
// Independiente del filtro de empresa/sede de arriba: siempre recorre TODAS
// las sedes de TODAS las empresas para el mes recibido.
// ---------------------------------------------------------------------------
async function computeGlobalOverview(month, filterFn) {
  const m = month || selectedMonth();
  const [y, mm] = m.split('-').map(Number);
  const nextMonth = `${new Date(y, mm, 1).toISOString().slice(0, 7)}-01`; // mm ya es 1-indexado -> mes siguiente

  // filterFn opcional: recibe la empresa y decide si se incluye. Se usa para
  // el "Informe por proveedor" (filtra por company.provider_id) sin duplicar
  // todo este cálculo de bolsas/cartera.
  const allSites = [];
  state.companies.forEach(c => {
    if (filterFn && !filterFn(c)) return;
    (c.sites || []).forEach(s => allSites.push({ company: c, site: s }));
  });
  if (!allSites.length) return { month: m, rows: [], totals: null };

  const [bagResults, { data: hoursRows }] = await Promise.all([
    Promise.all(allSites.map(({ site: s }) =>
      sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` })
        .then(({ data }) => (data && data[0]) || { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 })
        .catch(() => ({ assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 }))
    )),
    sb.from('hour_records').select('site_id,hours,rate,paid').gte('record_date', `${m}-01`).lt('record_date', nextMonth),
  ]);

  const bySite = {};
  (hoursRows || []).forEach(h => {
    const k = h.site_id;
    if (!bySite[k]) bySite[k] = { paid: 0, owed: 0 };
    const val = Number(h.hours) * Number(h.rate);
    if (h.paid) bySite[k].paid += val; else bySite[k].owed += val;
  });

  const rows = allSites.map(({ company: c, site: s }, i) => {
    const bag = bagResults[i];
    const cartera = bySite[s.id] || { paid: 0, owed: 0 };
    return {
      companyId: c.id, companyName: c.name, siteId: s.id, siteName: s.name,
      assigned: bag.total, used: bag.used, remaining: bag.remaining,
      avancePct: bag.total ? Math.min(100, Math.round(100 * bag.used / bag.total)) : null,
      paidValue: cartera.paid, owedValue: cartera.owed,
    };
  });

  const totals = rows.reduce((a, r) => ({
    assigned: a.assigned + r.assigned, used: a.used + r.used, remaining: a.remaining + r.remaining,
    paidValue: a.paidValue + r.paidValue, owedValue: a.owedValue + r.owedValue,
  }), { assigned: 0, used: 0, remaining: 0, paidValue: 0, owedValue: 0 });
  totals.avancePct = totals.assigned ? Math.min(100, Math.round(100 * totals.used / totals.assigned)) : null;
  totals.companiesCount = new Set(rows.map(r => r.companyId)).size;
  totals.sitesCount = rows.length;

  return { month: m, rows, totals };
}

async function renderGlobalOverview() {
  const box = $('globalOverviewBox');
  if (!box) return;
  const m = selectedMonth();
  if ($('globalOverviewPeriod')) $('globalOverviewPeriod').textContent = typeof monthLabel === 'function' ? monthLabel(m) : m;
  try {
    const { rows, totals } = await computeGlobalOverview(m);
    if (!rows.length) {
      box.innerHTML = '<p class="empty">Todavía no tienes ninguna sede registrada. Agrega una empresa y una sede desde Configuración para ver aquí el resumen general.</p>';
      return;
    }
    box.innerHTML = `
      <div class="reportKpiRow" style="margin-bottom:14px">
        <div class="reportKpiCard c-blue"><div class="k-label">Empresas activas</div><div class="k-value">${totals.companiesCount}</div><div class="k-sub">${totals.sitesCount} sede(s) en total</div></div>
        <div class="reportKpiCard c-blue"><div class="k-label">Horas asignadas</div><div class="k-value">${totals.assigned} h</div><div class="k-sub">Bolsa del mes, todas las sedes</div></div>
        <div class="reportKpiCard c-green"><div class="k-label">Avance global</div><div class="k-value">${totals.avancePct === null ? '—' : totals.avancePct + '%'}</div><div class="k-sub">${totals.used} h ejecutadas de ${totals.assigned} h</div></div>
        <div class="reportKpiCard ${totals.owedValue > 0 ? 'c-orange' : 'c-green'}"><div class="k-label">Cartera pendiente</div><div class="k-value">${money(totals.owedValue)}</div><div class="k-sub">${totals.owedValue > 0 ? 'Por cobrar' : 'Al día'}</div></div>
      </div>
      <div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Asignadas</th><th>Usadas</th><th>Disponibles</th><th>Avance</th><th>Cartera</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${r.companyName}</td><td>${r.siteName}</td><td>${r.assigned} h</td><td>${r.used} h</td><td><b>${r.remaining} h</b></td><td>${r.avancePct === null ? '—' : r.avancePct + '%'}</td><td>${r.owedValue > 0 ? `<span class="badge unpaid">${money(r.owedValue)}</span>` : '<span class="badge paid">Al día</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (err) {
    console.error('Error cargando el resumen general:', err);
    box.innerHTML = '<p class="empty">No se pudo cargar el resumen general.</p>';
  }
}

function taskStatus(siteId, activityId) { return state.statusMap[`${siteId}|${activityId}`] || 'Pendiente'; }
function taskIsCompleted(siteId, activityId) { return taskStatus(siteId, activityId) === 'Completada'; }
// hour_records (state.hoursSite) se carga normalmente solo de la sede
// seleccionada — por eso, mientras el botón "Ver todas las empresas" de
// Horas o de Actividades esté activo, estas dos funciones (usadas también
// por el Dashboard y las tarjetas de Actividades de la sede seleccionada)
// leen en cambio de allHoursRows (todas las sedes, superconjunto), para que
// las horas de sedes que no son la seleccionada arriba salgan correctas.
function hoursSource() { return (hoursShowAll || activitiesShowAll) && allHoursRows ? allHoursRows : state.hoursSite; }
function taskHours(siteId, activityId) { return hoursSource().filter(h => h.site_id === siteId && h.activity_id === activityId).reduce((a, x) => a + Number(x.hours), 0); }
function taskMonthHours(siteId, activityId, m) { return hoursSource().filter(h => h.site_id === siteId && h.activity_id === activityId && monthOf(h.record_date) === m).reduce((a, x) => a + Number(x.hours), 0); }
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

  // Proveedores: en consultas aparte y "a prueba de fallos" — si todavía no
  // se corrió la migración que crea "providers"/"companies.provider_id" en
  // Supabase, esto falla en silencio y el resto de la app sigue funcionando
  // normal (solo no se muestra columna de proveedor todavía).
  try {
    const [{ data: providers }, { data: companyProviders }] = await Promise.all([
      sb.from('providers').select('*').order('name'),
      sb.from('companies').select('id,provider_id'),
    ]);
    state.providers = providers || [];
    const provMap = new Map((companyProviders || []).map(cp => [cp.id, cp.provider_id]));
    state.companies.forEach(c => { c.provider_id = provMap.get(c.id) ?? null; });
  } catch (e) {
    state.providers = [];
  }

  // Datos fijos de Yasbleidis para la Cuenta de cobro (migración 0012) —
  // también "a prueba de fallos": si todavía no se corrió esa migración, la
  // Cuenta de cobro simplemente muestra los campos vacíos hasta que se
  // guarden desde Configuración → Mis datos.
  try {
    const { data: advisor } = await sb.from('advisor_profile').select('*').eq('id', true).maybeSingle();
    state.advisorProfile = advisor || null;
  } catch (e) {
    state.advisorProfile = null;
  }

  $('filterMonth').value = monthNow();
  if ($('calendarDate')) $('calendarDate').value = today();
  $('filterCompany').innerHTML = options(state.companies);
  refreshSitesFilter();
  if ($('reportMonth')) $('reportMonth').value = selectedMonth();
  if ($('reportProvider')) {
    $('reportProvider').innerHTML = state.providers.length
      ? state.providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('')
      : '<option value="">(sin proveedores creados)</option>';
  }
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

  // Estado (statusMap), metas (targetsMap) y cierres de mes (closedMonths)
  // se cargan de TODAS las sedes de TODAS las empresas (no solo la
  // seleccionada arriba): son tablas chicas, y cargarlas completas es lo
  // que permite que "Ver todas las empresas" (Horas/Actividades) y el
  // resumen general del Dashboard muestren el estado real de cualquier
  // sede sin tener que ir sede por sede. hour_records (state.hoursSite)
  // sigue cargándose solo de la sede seleccionada por defecto — esa sí
  // puede crecer mucho — y solo se trae completa (allHoursRows) cuando se
  // activa alguno de los botones "Ver todas las empresas".
  const [{ data: statusRowsAll }, { data: targetRowsAll }, { data: closedRowsAll }] = await Promise.all([
    sb.from('v_activity_current_status').select('*'),
    sb.from('activity_targets').select('site_id,activity_id,target_hours'),
    sb.from('month_closures').select('site_id,month').is('reopened_at', null),
  ]);
  state.statusMap = {};
  (statusRowsAll || []).forEach(r => { state.statusMap[`${r.site_id}|${r.activity_id}`] = r.status; });
  state.targetsMap = {};
  (targetRowsAll || []).forEach(r => { state.targetsMap[`${r.site_id}|${r.activity_id}`] = Number(r.target_hours); });
  state.closedMonths = new Set((closedRowsAll || []).map(r => `${r.site_id}|${r.month.slice(0, 7)}`));
  if (hoursShowAll || activitiesShowAll) {
    const { data: allHours } = await sb.from('hour_records').select('*');
    allHoursRows = allHours || [];
  }

  const s = site();
  if (!s) {
    // Todavía no hay ninguna empresa/sede creada (primera vez usando el
    // panel, o justo después de vaciar los datos de prueba). No hay nada
    // que consultar por sede, pero igual hay que pintar Configuración para
    // que aparezcan los botones "+ Agregar empresa" / "+ Agregar sede" /
    // "+ Nueva actividad" — antes esta función se detenía aquí mismo y
    // Configuración se quedaba en blanco para siempre.
    state.hoursSite = []; state.evidencesSite = []; state.calendarSite = []; state.expensesSite = [];
    state.bag = { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 };
    state.bagExists = false;
    renderBagAlert();
    renderDashboard();
    renderActivities();
    renderHours();
    renderMonthCloseBanner();
    renderEvidences();
    renderExpenses();
    await renderConfig();
    renderCalendar();
    renderNotifBell();
    renderMiniCalendar();
    if (typeof renderFullCalendar === 'function') renderFullCalendar();
    if (typeof refreshCalendarShowAll === 'function') await refreshCalendarShowAll();
    renderGlobalOverview();
    return;
  }

  // statusMap/targetsMap/closedMonths ya se cargaron arriba (todas las
  // sedes). Aquí solo quedan las consultas propias de la sede seleccionada.
  const [{ data: hours }, { data: evid }, { data: cal }, { data: bagRow }, { count }] = await Promise.all([
    sb.from('hour_records').select('*').eq('site_id', s.id),
    sb.from('evidences').select('*').eq('site_id', s.id).order('record_date', { ascending: false }),
    sb.from('schedule_events').select('*').eq('site_id', s.id),
    sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${selectedMonth()}-01` }),
    sb.from('monthly_bags').select('id', { count: 'exact', head: true }).eq('site_id', s.id).eq('month', `${selectedMonth()}-01`),
  ]);
  state.hoursSite = hours || [];
  state.evidencesSite = evid || [];
  state.calendarSite = cal || [];
  state.bag = (bagRow && bagRow[0]) || { assigned: 0, additional: 0, carry: 0, total: 0, used: 0, remaining: 0 };
  state.bagExists = !!count;

  // Viáticos (migración 0012): en consulta aparte y "a prueba de fallos" —
  // si todavía no se corrió esa migración, esta sección simplemente queda
  // vacía en vez de romper el resto de refreshAll.
  try {
    const { data: exp } = await sb.from('expenses').select('*').eq('site_id', s.id);
    state.expensesSite = exp || [];
  } catch (e) {
    state.expensesSite = [];
  }

  renderBagAlert();
  renderDashboard();
  renderActivities();
  renderHours();
  renderMonthCloseBanner();
  renderEvidences();
  renderExpenses();
  renderConfig();
  renderCalendar();
  renderNotifBell();
  renderMiniCalendar();
  if (typeof renderFullCalendar === 'function') renderFullCalendar();
  if (typeof refreshCalendarShowAll === 'function') await refreshCalendarShowAll();
  renderGlobalOverview();
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

// ---------------------------------------------------------------------------
// "Ver todas las empresas" (Actividades y Horas): dos botones independientes
// (uno por sección), que comparten la misma carga de fondo — allHoursRows,
// todos los hour_records sin filtrar por sede — para no duplicar la
// consulta si ambos están activos a la vez. Mientras ninguno de los dos
// esté activo, el comportamiento normal (una sola sede) no cambia en nada.
// ---------------------------------------------------------------------------
let hoursShowAll = false;
let hoursShowCompanyAll = false;
let activitiesShowAll = false;
let allHoursRows = null;

async function ensureAllHoursLoaded() {
  const { data } = await sb.from('hour_records').select('*');
  allHoursRows = data || [];
}

async function toggleHoursShowAll() {
  hoursShowAll = !hoursShowAll;
  if (hoursShowAll) { hoursShowCompanyAll = false; updateShowAllButton('hoursShowCompanyAllBtn', false, '🏢 Ver todas las sedes de esta empresa', '🏢 Viendo todas las sedes'); }
  if (hoursShowAll && !allHoursRows) await ensureAllHoursLoaded();
  updateShowAllButton('hoursShowAllBtn', hoursShowAll);
  renderHours();
}

// "Ver todas las sedes de esta empresa": a diferencia de "Ver todas las
// empresas" (que junta TODO sin importar la empresa elegida arriba), este
// botón respeta la empresa seleccionada en el filtro de arriba y solo junta
// sus distintas sedes en una sola tabla — para no tener que ir sede por
// sede dentro de la misma empresa. Reutiliza la misma carga de fondo
// (allHoursRows) que "Ver todas las empresas" para no duplicar la consulta.
async function toggleHoursShowCompanyAll() {
  hoursShowCompanyAll = !hoursShowCompanyAll;
  if (hoursShowCompanyAll) { hoursShowAll = false; updateShowAllButton('hoursShowAllBtn', false); }
  if (hoursShowCompanyAll && !allHoursRows) await ensureAllHoursLoaded();
  updateShowAllButton('hoursShowCompanyAllBtn', hoursShowCompanyAll, '🏢 Ver todas las sedes de esta empresa', '🏢 Viendo todas las sedes');
  renderHours();
}

async function toggleActivitiesShowAll() {
  activitiesShowAll = !activitiesShowAll;
  if (activitiesShowAll && !allHoursRows) await ensureAllHoursLoaded();
  updateShowAllButton('activitiesShowAllBtn', activitiesShowAll);
  renderActivities();
}

function updateShowAllButton(id, active, offLabel, onLabel) {
  const b = $(id); if (!b) return;
  b.classList.toggle('calToggleActive', active);
  b.textContent = active ? (onLabel || '👁️ Viendo todas las empresas') : (offLabel || '👁️ Ver todas las empresas');
}

function renderActivities() {
  if (activitiesShowAll) { renderActivitiesAll(); return; }
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

// Vista consolidada: una fila por (empresa, sede, actividad asignada a esa
// sede), con las mismas columnas que las tarjetas normales (horas
// acumuladas, horas del mes, estado, avance) más Empresa y Sede al
// principio. Usa exactamente las mismas funciones (taskStatus, taskHours,
// activityProgressBar) que las tarjetas, así que nunca puede desincronizarse
// de lo que se ve en la vista normal de una sola sede.
function renderActivitiesAll() {
  const m = selectedMonth();
  const rows = [];
  state.companies.forEach(c => (c.sites || []).forEach(s => {
    activitiesForSite(s.id).forEach(t => {
      const status = taskStatus(s.id, t.id);
      rows.push({
        companyName: c.name, siteName: s.name, siteId: s.id, activityId: t.id, name: t.name,
        status, totalH: taskHours(s.id, t.id), monthH: taskMonthHours(s.id, t.id, m),
      });
    });
  }));
  if (!rows.length) { $('activitiesList').innerHTML = '<p class="empty">Todavía no hay actividades asignadas en ninguna sede. Agrégalas desde Configuración → Actividades.</p>'; return; }
  $('activitiesList').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Actividad</th><th>Estado</th><th>Acumuladas</th><th>Este mes</th><th>Avance</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${r.companyName}</td><td>${r.siteName}</td><td>${r.name}</td><td><span class="badge ${r.status === 'Completada' ? 'done' : r.status === 'En proceso' ? 'progress' : 'pending'}">${r.status}</span></td><td>${r.totalH} h</td><td>${r.monthH} h</td><td>${activityProgressBar(r.siteId, r.activityId, r.totalH)}</td></tr>`).join('')}
  </tbody></table></div>`;
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
  if (hoursShowAll) { renderHoursRows(allHoursRows || [], true); return; }
  if (hoursShowCompanyAll) {
    const c = company();
    if (!c) { $('hoursTable').innerHTML = `<tr><td colspan="10" class="empty">${noSiteMessage()}</td></tr>`; return; }
    renderHoursRows((allHoursRows || []).filter(x => x.company_id === c.id), true);
    return;
  }
  const s = site();
  if (!s) { $('hoursTable').innerHTML = `<tr><td colspan="10" class="empty">${noSiteMessage()}</td></tr>`; return; }
  renderHoursRows(state.hoursSite.filter(x => x.site_id === s.id), false);
}

// showAll=false: comportamiento de siempre (empresa/sede de la fila = la
// seleccionada arriba, todas las filas son de esa sede).
// showAll=true: cada fila puede ser de una empresa/sede distinta — se busca
// en state.companies cuál es, para llenar la columna "Empresa / Sede".
function renderHoursRows(sourceRows, showAll) {
  const s = site();
  const rows = [...sourceRows].sort((a, b) => b.record_date.localeCompare(a.record_date));
  $('hoursTable').innerHTML = rows.length ? rows.map(x => {
    const c = showAll ? state.companies.find(cc => cc.id === x.company_id) : company();
    const st = showAll ? c?.sites.find(ss => ss.id === x.site_id) : s;
    const closed = monthClosed(x.site_id, monthOf(x.record_date));
    const editBtn = closed
      ? `<span class="small" title="El mes de este registro ya está cerrado">🔒 Cerrado</span>`
      : `<button class="secondary" data-requires-write onclick="editHours('${x.id}')">Editar</button>`;
    // El % de avance es de la ACTIVIDAD completa en esta sede (horas
    // acumuladas de todos sus registros / meta configurada), no solo de
    // este registro puntual — por eso se repite en cada fila de la misma
    // actividad, igual que en Dashboard y Actividades.
    const avance = activityProgressBar(x.site_id, x.activity_id, taskHours(x.site_id, x.activity_id));
    return `<tr><td>${x.record_date}</td><td>${c?.name || '—'}<br><span class="small">${st?.name || ''}</span></td><td>${taskName(x.activity_id)}</td><td>${avance}</td><td><span class="badge ${x.status === 'Completado' ? 'done' : 'progress'}">${x.status}</span></td><td>${x.hours}</td><td>${money(x.rate)}</td><td>${money(x.hours * x.rate)}</td><td><button class="badge ${x.paid ? 'paid' : 'unpaid'}" data-requires-write onclick="togglePaid('${x.id}',${!x.paid})">${x.paid ? '✓ Pagado' : '⏳ Pendiente'}</button></td><td style="white-space:nowrap">${editBtn} <button class="danger" data-requires-write onclick="deleteItem('hour_records','${x.id}')">Eliminar</button></td></tr>`;
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

// ---------------------------------------------------------------------------
// Viáticos / gastos de desplazamiento y representación (migración 0012).
// Misma lógica que Registro de horas (ligados a empresa+sede seleccionada),
// pero sin bolsa ni cierre de mes: son gastos, no horas ejecutadas. Se usan
// en la sección 2 de la Cuenta de cobro (Informes → Cuenta de cobro).
// ---------------------------------------------------------------------------
function renderExpenses() {
  const s = site();
  if (!s) { if ($('expensesTable')) $('expensesTable').innerHTML = `<tr><td colspan="5" class="empty">${noSiteMessage()}</td></tr>`; return; }
  const rows = [...state.expensesSite].sort((a, b) => b.record_date.localeCompare(a.record_date));
  const c = company();
  if ($('expensesTable')) $('expensesTable').innerHTML = rows.length ? rows.map(x => `<tr><td>${x.record_date}</td><td>${c?.name || '—'}<br><span class="small">${s?.name || ''}</span></td><td>${x.concept}</td><td>${money(x.amount)}</td><td style="white-space:nowrap"><button class="secondary" data-requires-write onclick="editExpense('${x.id}')">Editar</button> <button class="danger" data-requires-write onclick="deleteItem('expenses','${x.id}')">Eliminar</button></td></tr>`).join('') : `<tr><td colspan="5" class="empty">No hay gastos registrados.</td></tr>`;
}

let editingExpenseId = null;
function openExpenseModal() {
  if (!company() || !site()) return toast('Primero agrega una empresa y una sede desde Configuración.');
  editingExpenseId = null;
  $('expenseModalTitle').textContent = 'Registrar gasto';
  $('expCompany').innerHTML = options(state.companies); $('expCompany').value = company().id;
  fillSiteSelect('expCompany', 'expSite'); $('expSite').value = site().id;
  $('expDate').value = today(); $('expConcept').value = ''; $('expAmount').value = '';
  openModal('expenseModal');
}
function editExpense(id) {
  const x = state.expensesSite.find(e => e.id === id);
  if (!x) return;
  editingExpenseId = id;
  $('expenseModalTitle').textContent = 'Editar gasto';
  const c = state.companies.find(cc => cc.id === x.company_id);
  $('expCompany').innerHTML = options(state.companies); $('expCompany').value = c ? c.id : company().id;
  fillSiteSelect('expCompany', 'expSite'); $('expSite').value = x.site_id;
  $('expDate').value = x.record_date; $('expConcept').value = x.concept; $('expAmount').value = x.amount;
  openModal('expenseModal');
}
$('expCompany')?.addEventListener('change', () => fillSiteSelect('expCompany', 'expSite'));

async function saveExpense() {
  const amount = Number($('expAmount').value); if (!(amount >= 0)) return toast('Ingresa un valor válido.');
  const concept = $('expConcept').value.trim(); if (!concept) return toast('Escribe el concepto del gasto (ej: transporte y alimentación).');
  const c = state.companies.find(x => x.id === $('expCompany').value), s = c?.sites.find(x => x.id === $('expSite').value);
  if (!s) return toast('Selecciona una sede válida.');
  const payload = { company_id: c.id, site_id: s.id, record_date: $('expDate').value, concept, amount, created_by: currentProfile?.id };
  const { error } = editingExpenseId
    ? await sb.from('expenses').update(payload).eq('id', editingExpenseId)
    : await sb.from('expenses').insert(payload);
  if (error) return toast('No se pudo guardar el gasto: ' + error.message + (error.message?.includes('expenses') || error.message?.includes('amount') ? ' (falta correr la migración 0013 en Supabase, o falta recargar el schema cache si ya la corriste).' : ''));
  closeModal('expenseModal'); editingExpenseId = null;
  await refreshAll();
  toast('Gasto guardado.');
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
  // Con "Ver todas las empresas" activo, la fila puede pertenecer a una
  // sede distinta de la seleccionada arriba — en ese caso no está en
  // state.hoursSite (que solo trae la sede actual), sino en allHoursRows.
  const r = state.hoursSite.find(x => x.id === id) || (allHoursRows || []).find(x => x.id === id);
  if (!r) return;
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
  // La bolsa de horas (presupuesto mensual) solo se valida al REGISTRAR
  // horas nuevas, que es lo que realmente la consume. Editar un registro ya
  // existente es corregir fecha/horas/actividad de algo que ya se ejecutó —
  // no vuelve a consumir bolsa, así que la edición no se bloquea por
  // disponibilidad (la bolsa en sí no cambia con la edición).
  if (!wasEditing) {
    const { data: bagData } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
    const available = (bagData && bagData[0]?.remaining) || 0;
    if (h > available) {
      toast(`Para ${m} solo quedan ${available} h en la bolsa. Puedes agregar horas adicionales al mes.`);
      closeModal('hoursModal'); openAdditionalHoursModal(c.id, s.id, m);
      return;
    }
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
function openEvidenceModal() { if (!company() || !site()) return toast('Primero agrega una empresa y una sede desde Configuración.'); fillCommon('eCompany', 'eSite', 'eTask'); $('eCompany').value = company().id; fillSiteSelect('eCompany', 'eSite'); $('eSite').value = site().id; refreshEvidenceTaskOptions(); $('eDate').value = today(); $('eLink').value = ''; $('eDesc').value = ''; $('eFile').value = ''; setEvidenceSaving(false); openModal('evidenceModal'); }
$('eCompany')?.addEventListener('change', () => { fillSiteSelect('eCompany', 'eSite'); refreshEvidenceTaskOptions(); });
$('eSite')?.addEventListener('change', refreshEvidenceTaskOptions);
function setEvidenceSaving(isSaving) {
  const btn = document.querySelector('#evidenceModal .primary');
  if (btn) { btn.disabled = isSaving; btn.textContent = isSaving ? 'Subiendo…' : 'Guardar evidencia'; }
}
function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function saveEvidence() {
  const file = $('eFile').files[0], link = $('eLink').value.trim();
  if (!file && !link) return toast('Carga un archivo o agrega un link');
  const c = $('eCompany').value, s = $('eSite').value, t = $('eTask').value;
  let storagePath = null, fileName = null;
  setEvidenceSaving(true);
  try {
    if (file) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      toast(`Subiendo archivo (${sizeMB} MB)… puede tardar un momento, no cierres esta ventana.`, 8000);
      storagePath = `${s}/${Date.now()}-${file.name}`;
      let upErr;
      try {
        ({ error: upErr } = await withTimeout(
          sb.storage.from('evidencias').upload(storagePath, file),
          90000,
          'La subida tardó demasiado y se canceló (más de 90 segundos). Puede deberse a tu conexión, al tamaño del archivo o a un antivirus revisando el PDF antes de enviarlo. Intenta de nuevo o prueba con un PDF más liviano.'
        ));
      } catch (timeoutErr) {
        toast(timeoutErr.message, 6000);
        return;
      }
      if (upErr) return toast('No se pudo subir el archivo: ' + upErr.message);
      fileName = file.name;
    }
    const { error } = await sb.from('evidences').insert({
      company_id: c, site_id: s, activity_id: t, record_date: $('eDate').value,
      link: link || null, description: $('eDesc').value, storage_path: storagePath, file_name: fileName, created_by: currentProfile?.id,
    });
    if (error) return toast('No se pudo guardar: ' + error.message);
    closeModal('evidenceModal'); await refreshAll(); toast('Evidencia registrada');
  } finally {
    setEvidenceSaving(false);
  }
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
  ['companies', 'sites', 'rates', 'tasks', 'providers', 'mydata', 'migration'].forEach(x => $('cfg-' + x).style.display = x === tab ? 'block' : 'none');
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function renderConfig() {
  const m = selectedMonth();
  // Una empresa sin ninguna sede queda "inactiva" (se puede eliminar su
  // última sede sin que eso borre la empresa) — se marca aquí para que se
  // note de un vistazo que necesita una sede nueva para volver a operar.
  // La columna "Proveedor" queda siempre visible (no depende de si la
  // empresa ya tiene uno asignado) para que quede presente al editar
  // cualquier empresa, y así asignarlo/cambiarlo cuando haga falta.
  $('cfg-companies').innerHTML = `<div class="panelhead"><h2>Empresas</h2><button class="primary" data-requires-write onclick="openCompanyWizard()">+ Agregar empresa</button></div><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sedes</th><th>Proveedor</th><th>Estado</th><th></th></tr></thead><tbody>${state.companies.map(c => `<tr><td>${c.name}</td><td>${c.sites.length}</td><td><select id="prov-${c.id}" style="min-width:190px"><option value="">Sin proveedor</option>${state.providers.map(p => `<option value="${p.id}" ${c.provider_id === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}</select> <button class="secondary" data-requires-write onclick="updateCompanyProvider('${c.id}')">Guardar</button></td><td>${c.sites.length ? '<span class="badge done">Activa</span>' : '<span class="badge pending" title="Sin sedes: agrega una desde Sedes y horas para activarla">Inactiva</span>'}</td><td><button class="danger" data-requires-write onclick="removeCompany('${c.id}')">Eliminar</button></td></tr>`).join('')}</tbody></table></div>`;

  const rows = [];
  for (const c of state.companies) {
    for (const s of c.sites) {
      const { data } = await sb.rpc('get_bag_summary', { p_site_id: s.id, p_month: `${m}-01` });
      const b = (data && data[0]) || { assigned: 0, carry: 0, additional: 0, used: 0, remaining: 0 };
      rows.push(`<tr><td>${c.name}</td><td>${s.name}</td><td>${b.assigned} h</td><td>${b.carry} h</td><td>${b.additional} h</td><td>${b.used} h</td><td><b>${b.remaining} h</b></td><td style="white-space:nowrap"><button class="primary" data-requires-write onclick="openMonthlyBagModal('${c.id}','${s.id}','${m}')">Asignar</button> <button class="success" data-requires-write onclick="openAdditionalHoursModal('${c.id}','${s.id}','${m}')">+ Horas</button> <button class="secondary" data-requires-write onclick="openSiteActivitiesModal('${c.id}','${s.id}')">Actividades</button> <button class="danger" data-requires-write onclick="removeSite('${c.id}','${s.id}')">Eliminar</button></td></tr>`);
    }
  }
  $('cfg-sites').innerHTML = `<div class="panelhead"><h2>Bolsas mensuales de horas</h2><div><button class="success" data-requires-write onclick="openMonthlyBagModal()">+ Asignar bolsa del mes</button> <button class="primary" data-requires-write onclick="openSiteWizard()">+ Agregar sede</button></div></div><p class="small">Periodo mostrado: <b>${m}</b>. El saldo no utilizado del mes anterior se suma automáticamente como saldo a favor.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Sede</th><th>Asignadas</th><th>Saldo anterior</th><th>Adicionales</th><th>Usadas</th><th>Disponibles</th><th>Acción</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  // La tarifa se propone automáticamente al registrar horas nuevas, y se
  // toma del PROVEEDOR de la empresa cuando ese proveedor tiene una tarifa
  // cargada (todas sus empresas cobran igual — se edita en Proveedores, no
  // aquí). Solo las empresas sin proveedor, o cuyo proveedor todavía no
  // tiene tarifa propia, mantienen su tarifa editable aquí. Cambiar esto no
  // afecta los registros ya guardados (cada uno conserva la tarifa con la
  // que se creó).
  $('cfg-rates').innerHTML = `<div class="panelhead"><h2>Tarifas por empresa</h2></div><p class="small">Si una empresa tiene proveedor y ese proveedor tiene tarifa cargada, se usa esa (edítala en Proveedores). Las empresas sin proveedor, o cuyo proveedor no tiene tarifa propia, usan su propia tarifa aquí.</p><div class="tablewrap"><table><thead><tr><th>Empresa</th><th>Tarifa por hora (COP)</th><th></th></tr></thead><tbody>${state.companies.length ? state.companies.map(c => {
    const pRate = providerRateFor(c);
    if (pRate != null) {
      const p = state.providers.find(x => x.id === c.provider_id);
      return `<tr><td>${c.name}</td><td>${money(pRate)} <span class="small">(tarifa de ${p?.name || 'su proveedor'})</span></td><td><span class="small">Se edita en Proveedores</span></td></tr>`;
    }
    return `<tr><td>${c.name}</td><td><input id="rate-${c.id}" type="number" min="0" step="1000" value="${companyRate(c)}" style="width:150px"></td><td><button class="primary" data-requires-write onclick="updateCompanyRate('${c.id}')">Guardar</button></td></tr>`;
  }).join('') : '<tr><td colspan="3" class="empty">Todavía no tienes ninguna empresa registrada.</td></tr>'}</tbody></table></div>`;
  $('cfg-tasks').innerHTML = `<div class="panelhead"><h2>Actividades del proyecto</h2><button class="primary" data-requires-write onclick="addTaskPrompt()">+ Nueva actividad</button></div>${state.activities.map(t => `<div class="activity"><div class="activityTop"><div><b>${t.name}</b>${t.is_fixed ? '<div class="small">Actividad inicial establecida</div>' : '<div class="small">Actividad agregada</div>'}</div><button class="secondary" data-requires-write onclick="editTaskPrompt('${t.id}')">✏️ Editar nombre</button></div></div>`).join('')}`;

  // Proveedores: nombre + datos de facturación (NIT, gerente, dirección...)
  // usados para llenar solos el encabezado de la Cuenta de cobro de cada
  // proveedor (Informes → Cuenta de cobro).
  $('cfg-providers').innerHTML = `<div class="panelhead"><h2>Proveedores</h2><button class="primary" data-requires-write onclick="addProviderPrompt()">+ Agregar proveedor</button></div><p class="small">Estos datos llenan el encabezado de la Cuenta de cobro de cada proveedor. El nombre es obligatorio; lo demás es opcional. Si cargas una tarifa por hora, se propone sola para todas las empresas de este proveedor (migración 0018).</p>${state.providers.length ? state.providers.map(p => `
    <div class="panel" style="margin-bottom:14px">
      <div class="formgrid">
        <div><label>Nombre</label><input id="provName-${p.id}" value="${p.name || ''}"></div>
        <div><label>NIT</label><input id="provNit-${p.id}" value="${p.nit || ''}"></div>
        <div><label>Gerente / contacto</label><input id="provGerente-${p.id}" value="${p.gerente || ''}"></div>
        <div><label>Dirección</label><input id="provDireccion-${p.id}" value="${p.direccion || ''}"></div>
        <div><label>Ciudad</label><input id="provCiudad-${p.id}" value="${p.ciudad || ''}"></div>
        <div><label>Teléfono</label><input id="provTelefono-${p.id}" value="${p.telefono || ''}"></div>
        <div><label>Tarifa por hora (COP)</label><input id="provRate-${p.id}" type="number" min="0" step="1000" value="${p.rate || ''}" placeholder="Aplica a todas sus empresas"></div>
        <div class="full"><label>Email de radicación de cuentas</label><input id="provEmail-${p.id}" value="${p.email_radicacion || ''}"></div>
      </div>
      <button class="primary" data-requires-write onclick="updateProvider('${p.id}')" style="margin-top:10px">Guardar</button>
    </div>`).join('') : '<p class="empty">Todavía no tienes proveedores. Agrega uno con el botón de arriba, o corre la migración 0011_providers.sql en Supabase si esperabas ver los que ya te sugerí (OrientarSalud, Rehavid SAS, ARL Positiva).</p>'}`;

  // Mis datos: fijos de Yasbleidis, usados en cualquier Cuenta de cobro sin
  // importar el proveedor (Configuración → Mis datos).
  renderMyDataPanel();
}

// ---------------------------------------------------------------------------
// Mis datos (Configuración → Mis datos): es la titular, una sola persona —
// por eso NO es un formulario de "agregar" siempre visible. Por defecto se
// muestran sus datos ya cargados en modo lectura, y un botón "Editar" abre
// el mismo formulario de siempre (con Guardar/Cancelar) para corregirlos.
// ---------------------------------------------------------------------------
let advisorEditMode = false;

function toggleAdvisorEdit(mode) {
  advisorEditMode = mode;
  renderMyDataPanel();
}

function renderMyDataPanel() {
  if (!$('cfg-mydata')) return;
  const adv = state.advisorProfile || {};

  if (!advisorEditMode) {
    const row = (label, value) => value ? `<span class="lbl">${label}:</span><span class="val">${value}</span>` : '';
    const rows = [
      ['Cédula', adv.cedula],
      ['Profesión', adv.profesion],
      ['Registro profesional', adv.registro_profesional],
      ['Licencia SST', adv.licencia_sst],
      ['Dirección', adv.direccion],
      ['Ciudad', [adv.ciudad, adv.departamento].filter(Boolean).join(' · ')],
      ['Teléfono', adv.telefono],
      ['Celular', adv.celular],
      ['Email', adv.email],
      ['Banco', adv.banco],
      ['Cuenta bancaria', adv.cuenta_bancaria],
      ['Nequi', adv.nequi],
      ['Llave Bre-B', adv.llave_bre_b],
      ['Información tributaria', adv.regimen_iva],
      ['Actividad económica', adv.actividad_economica],
    ].map(([l, v]) => row(l, v)).filter(Boolean).join('');

    $('cfg-mydata').innerHTML = `<div class="panelhead"><h2>Mis datos</h2><button class="secondary" data-requires-write onclick="toggleAdvisorEdit(true)">✏️ Editar</button></div>
    <p class="small">Datos de Yasbleidis López Rhenals, titular, usados para llenar automáticamente el encabezado de cada Cuenta de cobro.</p>
    ${rows ? `<div class="reportInfoBox" style="grid-template-columns:auto 1fr;margin-top:10px">${rows}</div>` : '<p class="empty">Todavía no hay datos cargados. Da clic en "Editar" para completarlos.</p>'}`;
    return;
  }

  $('cfg-mydata').innerHTML = `<div class="panelhead"><h2>Mis datos</h2></div><p class="small">Estos datos se usan para llenar automáticamente el encabezado de cada Cuenta de cobro que generes desde Informes.</p>
  <div class="formgrid">
    <div><label>Cédula</label><input id="advCedula" value="${adv.cedula || ''}"></div>
    <div><label>Profesión</label><input id="advProfesion" value="${adv.profesion || ''}"></div>
    <div><label>Registro profesional</label><input id="advRegistro" value="${adv.registro_profesional || ''}"></div>
    <div><label>Licencia SST</label><input id="advLicenciaSst" value="${adv.licencia_sst || ''}"></div>
    <div><label>Dirección</label><input id="advDireccion" value="${adv.direccion || ''}"></div>
    <div><label>Ciudad</label><input id="advCiudad" value="${adv.ciudad || ''}"></div>
    <div><label>Departamento</label><input id="advDepartamento" value="${adv.departamento || ''}"></div>
    <div><label>Teléfono</label><input id="advTelefono" value="${adv.telefono || ''}"></div>
    <div><label>Celular</label><input id="advCelular" value="${adv.celular || ''}"></div>
    <div><label>Email</label><input id="advEmail" value="${adv.email || ''}"></div>
    <div><label>Banco</label><input id="advBanco" value="${adv.banco || ''}"></div>
    <div><label>Cuenta bancaria</label><input id="advCuenta" value="${adv.cuenta_bancaria || ''}"></div>
    <div><label>Nequi</label><input id="advNequi" placeholder="Número celular Nequi" value="${adv.nequi || ''}"></div>
    <div><label>Llave Bre-B (Bancolombia)</label><input id="advLlaveBreB" placeholder="Celular, cédula, correo o alias" value="${adv.llave_bre_b || ''}"></div>
    <div><label>Régimen de IVA</label><input id="advRegimen" value="${adv.regimen_iva || 'IVA Régimen Simplificado'}"></div>
    <div class="full"><label>Actividad económica</label><input id="advActividad" value="${adv.actividad_economica || ''}"></div>
  </div>
  <div class="actions" style="justify-content:flex-start">
    <button class="secondary" onclick="toggleAdvisorEdit(false)">Cancelar</button>
    <button class="primary" data-requires-write onclick="saveAdvisorProfile()">Guardar cambios</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Eliminar empresa: antes de confirmar, se muestran las cantidades reales de
// todo lo que se va a borrar (sedes, horas, evidencias, agenda, gastos), y se
// exige escribir el nombre exacto de la empresa para habilitar el botón — así
// se evita un borrado accidental de algo que no se puede deshacer.
// ---------------------------------------------------------------------------
let deleteCompanyTarget = null;

function removeCompany(id) {
  if (state.companies.length <= 1) return toast('Debe existir al menos una empresa');
  const c = state.companies.find(x => x.id === id);
  if (!c) return;
  openDeleteCompanyModal(c);
}

async function openDeleteCompanyModal(c) {
  deleteCompanyTarget = c;
  $('delCompanyName').textContent = c.name;
  $('delCompanyConfirmInput').value = '';
  $('delCompanyConfirmBtn').disabled = true;
  $('delCompanySummary').innerHTML = `<div class="warningBox"><p>Calculando lo que se eliminaría de "${c.name}"…</p></div>`;
  openModal('deleteCompanyModal');

  const countOf = async (table) => {
    try {
      const { count } = await sb.from(table).select('id', { count: 'exact', head: true }).eq('company_id', c.id);
      return count || 0;
    } catch (e) { return 0; }
  };
  const [hrCount, evCount, schCount, expCount] = await Promise.all([
    countOf('hour_records'), countOf('evidences'), countOf('schedule_events'), countOf('expenses'),
  ]);

  // Si el usuario ya cerró el modal o eligió otra empresa mientras se
  // calculaban los conteos, no se pisa el contenido que esté mostrando ahora.
  if (deleteCompanyTarget?.id !== c.id) return;

  $('delCompanySummary').innerHTML = `
    <div class="warningBox">
      <p>Esto eliminará <b>de forma permanente e irreversible</b> la empresa <b>"${c.name}"</b> y todo lo que depende de ella:</p>
      <ul>
        <li>${c.sites.length} sede(s)</li>
        <li>${hrCount} registro(s) de horas</li>
        <li>${evCount} evidencia(s)</li>
        <li>${schCount} evento(s) de agenda</li>
        <li>${expCount} gasto(s)/viático(s) de desplazamiento</li>
      </ul>
      <p style="margin-top:10px">No hay forma de recuperar esta información después de eliminarla.</p>
    </div>`;
}

function checkDeleteCompanyConfirm() {
  $('delCompanyConfirmBtn').disabled = !deleteCompanyTarget || $('delCompanyConfirmInput').value.trim() !== deleteCompanyTarget.name;
}

async function executeDeleteCompany() {
  if (!deleteCompanyTarget || $('delCompanyConfirmInput').value.trim() !== deleteCompanyTarget.name) return;
  const target = deleteCompanyTarget;
  const btn = $('delCompanyConfirmBtn'); btn.disabled = true; const originalText = btn.textContent; btn.textContent = 'Eliminando…';
  try {
    // Se deja constancia en la bitácora ANTES de borrar (después ya no habría
    // una empresa válida a la cual asociar el registro).
    await logActivity('company_deleted', `Se eliminó la empresa "${target.name}" y todos sus datos asociados (sedes, horas, evidencias, agenda y gastos).`, { companyId: target.id });
    const { error } = await sb.from('companies').delete().eq('id', target.id);
    if (error) return toast('No se pudo eliminar: ' + error.message + (error.message?.toLowerCase().includes('foreign key') ? ' (falta correr la migración 0014 en Supabase).' : ''));
    deleteCompanyTarget = null;
    closeModal('deleteCompanyModal');
    await init();
    toast(`Empresa "${target.name}" eliminada junto con todos sus datos.`);
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
}

// ---------------------------------------------------------------------------
// Wizard: Agregar empresa/sede en 3 pasos (Empresa -> Sede -> Actividades).
// Al guardar se crean empresa (si aplica) + sede + actividades nuevas (si se
// escribieron) y se asignan todas las actividades marcadas a esa sede en
// site_activities, en un solo flujo.
// ---------------------------------------------------------------------------
let wizardMode = 'company'; // 'company' (empresa nueva) | 'site' (sede nueva en empresa existente)
let wizardStepKey = 'company';
let wizardSelectedActivityIds = new Set();
let wizardNewActivities = [];
let wizardSelectedProviderId = null;

// Secuencia de pasos por modo: al crear una empresa nueva se pide primero el
// proveedor (paso 1), y de ahí sigue el flujo de siempre. Al agregar una sede
// a una empresa existente el proveedor ya está definido, así que ese paso se
// omite.
const WIZARD_STEPS = {
  company: ['provider', 'company', 'site', 'activities'],
  site: ['company', 'site', 'activities'],
};
const WIZARD_PANE_ID = { provider: 'wizardPaneProvider', company: 'wizardPane1', site: 'wizardPane2', activities: 'wizardPane3' };
const WIZARD_STEP_LABEL = { provider: 'Proveedor', company: 'Empresa', site: 'Sede', activities: 'Actividades' };

function openCompanyWizard() {
  wizardMode = 'company'; wizardSelectedActivityIds = new Set(); wizardNewActivities = []; wizardSelectedProviderId = null;
  $('wizardTitle').textContent = 'Agregar empresa';
  $('wizStepCompanyNew').style.display = 'block';
  $('wizStepCompanyExisting').style.display = 'none';
  $('wizCompanyName').value = '';
  $('wizSiteName').value = ''; $('wizSiteHours').value = 0;
  $('wizNewActivityName').value = '';
  renderWizardStepsBar();
  wizardShowStep(WIZARD_STEPS.company[0]);
  openModal('companyWizardModal');
}

function openSiteWizard() {
  if (!state.companies.length) return toast('Primero agrega una empresa.');
  wizardMode = 'site'; wizardSelectedActivityIds = new Set(); wizardNewActivities = []; wizardSelectedProviderId = null;
  $('wizardTitle').textContent = 'Agregar sede';
  $('wizStepCompanyNew').style.display = 'none';
  $('wizStepCompanyExisting').style.display = 'block';
  $('wizCompanySelect').innerHTML = options(state.companies);
  $('wizCompanySelect').value = company()?.id || state.companies[0].id;
  $('wizSiteName').value = ''; $('wizSiteHours').value = 0;
  $('wizNewActivityName').value = '';
  renderWizardStepsBar();
  wizardShowStep(WIZARD_STEPS.site[0]);
  openModal('companyWizardModal');
}

function renderWizardStepsBar() {
  const steps = WIZARD_STEPS[wizardMode];
  $('wizardStepsBar').innerHTML = steps.map((k, i) => `<span class="wizardStep" data-step="${k}">${i + 1}. ${WIZARD_STEP_LABEL[k]}</span>`).join('');
}

function renderWizardProviderSelect() {
  $('wizProviderSelect').innerHTML = '<option value="">Sin proveedor</option>' + state.providers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  $('wizProviderSelect').value = wizardSelectedProviderId || '';
}

async function wizardAddProviderPrompt() {
  const n = prompt('Nombre del nuevo proveedor:');
  if (!n?.trim()) return;
  const { data, error } = await sb.from('providers').insert({ name: n.trim() }).select('id').single();
  if (error) return toast('No se pudo crear el proveedor: ' + error.message);
  state.providers.push({ id: data.id, name: n.trim() });
  wizardSelectedProviderId = data.id;
  renderWizardProviderSelect();
  toast('Proveedor agregado.');
}

function wizardShowStep(key) {
  wizardStepKey = key;
  const steps = WIZARD_STEPS[wizardMode];
  Object.entries(WIZARD_PANE_ID).forEach(([k, id]) => { const el = $(id); if (el) el.style.display = k === key ? 'block' : 'none'; });
  document.querySelectorAll('.wizardStep').forEach(el => el.classList.toggle('active', el.dataset.step === key));
  const idx = steps.indexOf(key);
  $('wizBackBtn').style.display = idx > 0 ? 'inline-block' : 'none';
  $('wizNextBtn').textContent = idx === steps.length - 1 ? 'Guardar' : 'Siguiente';
  if (key === 'activities') renderWizardActivities();
  if (key === 'provider') renderWizardProviderSelect();
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

function wizardBack() {
  const steps = WIZARD_STEPS[wizardMode];
  const idx = steps.indexOf(wizardStepKey);
  if (idx > 0) wizardShowStep(steps[idx - 1]);
}

async function wizardNext() {
  const steps = WIZARD_STEPS[wizardMode];
  const idx = steps.indexOf(wizardStepKey);
  if (wizardStepKey === 'provider') {
    wizardSelectedProviderId = $('wizProviderSelect').value || null;
  } else if (wizardStepKey === 'company') {
    if (wizardMode === 'company') {
      if (!$('wizCompanyName').value.trim()) return toast('Ingresa el nombre de la empresa');
    } else if (!$('wizCompanySelect').value) {
      return toast('Selecciona una empresa');
    }
  } else if (wizardStepKey === 'site') {
    if (!$('wizSiteName').value.trim()) return toast('Ingresa el nombre de la sede');
  }
  if (idx === steps.length - 1) return await wizardSave();
  wizardShowStep(steps[idx + 1]);
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
      const { data, error } = await sb.from('companies').insert({ name: companyName, rate: state.rate, provider_id: wizardSelectedProviderId || null }).select('id').single();
      if (error && error.code === PG_UNIQUE_VIOLATION) {
        const { data: existing, error: findError } = await sb.from('companies').select('id').eq('name', companyName).maybeSingle();
        if (findError || !existing) return toast('Ya existe una empresa con ese nombre, pero no se pudo recuperar: ' + (findError?.message || 'sin detalle'));
        companyId = existing.id;
        // Si la empresa ya existía sin proveedor asignado y en el wizard se
        // eligió uno, lo completamos en vez de dejarlo pasar por alto.
        if (wizardSelectedProviderId) {
          const { data: existingFull } = await sb.from('companies').select('provider_id').eq('id', companyId).maybeSingle();
          if (existingFull && !existingFull.provider_id) {
            await sb.from('companies').update({ provider_id: wizardSelectedProviderId }).eq('id', companyId);
          }
        }
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

async function updateCompanyProvider(id) {
  const select = $('prov-' + id);
  const providerId = select?.value || null;
  const { error } = await sb.from('companies').update({ provider_id: providerId }).eq('id', id);
  if (error) return toast('No se pudo actualizar el proveedor: ' + error.message + (error.message?.includes('provider_id') ? ' (falta correr la migración 0011_providers.sql en Supabase).' : ''));
  const c = state.companies.find(x => x.id === id);
  if (c) c.provider_id = providerId;
  const providerName = state.providers.find(p => p.id === providerId)?.name;
  toast(providerName ? `${c?.name || 'Empresa'} asignada a ${providerName}.` : `${c?.name || 'Empresa'} quedó sin proveedor.`);
}

// ---------------------------------------------------------------------------
// Configuración → Proveedores: alta rápida (solo nombre) + edición de los
// datos de facturación (NIT, gerente, dirección...) que se usan para llenar
// el encabezado de la Cuenta de cobro (migración 0012).
// ---------------------------------------------------------------------------
async function addProviderPrompt() {
  const n = prompt('Nombre del nuevo proveedor:');
  if (!n?.trim()) return;
  const { error } = await sb.from('providers').insert({ name: n.trim() });
  if (error) return toast('No se pudo crear el proveedor: ' + error.message);
  toast('Proveedor agregado. Completa sus datos de facturación abajo si los necesitas.');
  await init();
}
async function updateProvider(id) {
  const name = $('provName-' + id)?.value.trim();
  if (!name) return toast('El nombre del proveedor no puede quedar vacío.');
  const rateVal = Number($('provRate-' + id)?.value || 0);
  const payload = {
    name,
    nit: $('provNit-' + id)?.value.trim() || null,
    gerente: $('provGerente-' + id)?.value.trim() || null,
    direccion: $('provDireccion-' + id)?.value.trim() || null,
    ciudad: $('provCiudad-' + id)?.value.trim() || null,
    telefono: $('provTelefono-' + id)?.value.trim() || null,
    email_radicacion: $('provEmail-' + id)?.value.trim() || null,
    rate: rateVal > 0 ? rateVal : null,
  };
  const { error } = await sb.from('providers').update(payload).eq('id', id);
  if (error) return toast('No se pudo actualizar el proveedor: ' + error.message + (error.message?.includes('nit') || error.message?.includes('rate') ? ' (falta correr la migración 0012 y/o 0018 en Supabase).' : ''));
  const p = state.providers.find(x => x.id === id);
  if (p) Object.assign(p, payload);
  toast('Datos del proveedor actualizados.');
  renderConfig();
}

// ---------------------------------------------------------------------------
// Configuración → Mis datos: datos fijos de Yasbleidis (cédula, profesión,
// cuenta bancaria...) que se usan en el encabezado de cualquier Cuenta de
// cobro, sin importar el proveedor (migración 0012).
// ---------------------------------------------------------------------------
async function saveAdvisorProfile() {
  const payload = {
    id: true,
    cedula: $('advCedula').value.trim() || null,
    profesion: $('advProfesion').value.trim() || null,
    registro_profesional: $('advRegistro').value.trim() || null,
    licencia_sst: $('advLicenciaSst').value.trim() || null,
    direccion: $('advDireccion').value.trim() || null,
    ciudad: $('advCiudad').value.trim() || null,
    departamento: $('advDepartamento').value.trim() || null,
    telefono: $('advTelefono').value.trim() || null,
    celular: $('advCelular').value.trim() || null,
    email: $('advEmail').value.trim() || null,
    banco: $('advBanco').value.trim() || null,
    cuenta_bancaria: $('advCuenta').value.trim() || null,
    nequi: $('advNequi').value.trim() || null,
    llave_bre_b: $('advLlaveBreB').value.trim() || null,
    regimen_iva: $('advRegimen').value.trim() || null,
    actividad_economica: $('advActividad').value.trim() || null,
  };
  const { error } = await sb.from('advisor_profile').upsert(payload);
  if (error) return toast('No se pudo guardar: ' + error.message + (error.message?.includes('advisor_profile') || error.message?.includes('nequi') || error.message?.includes('llave_bre_b') || error.message?.includes('licencia_sst') ? ' (falta correr la migración 0016 en Supabase).' : ''));
  state.advisorProfile = payload;
  advisorEditMode = false;
  renderMyDataPanel();
  toast('Tus datos quedaron guardados.');
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
