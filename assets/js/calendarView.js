/**
 * Agenda / calendario: programación de sesiones, detección de cruces de
 * horario, generación de enlace de Google Calendar, archivo .ics, y correo
 * de confirmación editable para el líder de la sede — igual que en la
 * versión anterior, ahora persistido en la tabla schedule_events y con un
 * calendario visual real (FullCalendar) de día/semana/mes con arrastre.
 */
function scheduleCompanyChanged() { fillSiteSelect('scCompany', 'scSite'); }

function openScheduleModal() {
  fillCommon('scCompany', 'scSite', 'scTask');
  $('scCompany').value = company().id; fillSiteSelect('scCompany', 'scSite'); $('scSite').value = site().id;
  $('scLeader').value = ''; $('scEmail').value = ''; $('scProposedDate').value = ''; $('scProposedTime').value = '';
  $('scDate').value = $('calendarDate')?.value || today(); $('scTime').value = '09:00'; $('scDuration').value = 60; $('scReminder').value = '30'; $('scNotes').value = '';
  checkScheduleAvailability(); openModal('scheduleModal');
}
function eventDateTime(e) { return new Date(`${e.event_date}T${e.event_time}`); }
function eventEnd(e) { const d = eventDateTime(e); d.setMinutes(d.getMinutes() + Number(e.duration_minutes || 60)); return d; }
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }
function scheduleConflicts(date, time, duration, ignoreId) {
  if (!date || !time) return [];
  const start = new Date(`${date}T${time}:00`), end = new Date(start.getTime() + Number(duration || 60) * 60000);
  return state.calendarSite.filter(e => {
    if (e.id === ignoreId || e.event_date !== date) return false;
    return overlaps(start, end, eventDateTime(e), eventEnd(e));
  });
}
function checkScheduleAvailability() {
  const date = $('scDate')?.value, time = $('scTime')?.value, duration = Number($('scDuration')?.value || 60);
  const box = $('scheduleAvailability'); if (!box) return true;
  if (!date || !time) { box.className = 'scheduleInfo'; box.textContent = 'Selecciona fecha y hora para validar tu agenda.'; return true; }
  const conflicts = scheduleConflicts(date, time, duration);
  if (conflicts.length) {
    box.className = 'conflictBox conflictBad';
    box.innerHTML = `⚠️ <b>Horario ocupado:</b> tienes ${conflicts.length} programación que se cruza con esta sesión. ${conflicts.map(e => `${e.event_time} · ${taskName(e.activity_id)}`).join(' | ')}`;
    return false;
  }
  box.className = 'conflictBox conflictOk';
  box.innerHTML = `✓ <b>Horario disponible.</b> No hay actividades programadas en tu agenda interna que se crucen entre ${time} y ${new Date(new Date(`${date}T${time}:00`).getTime() + duration * 60000).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}.`;
  return true;
}
function leaderEmailBody(e) {
  const c = state.companies.find(x => x.id === e.company_id), s = c?.sites.find(x => x.id === e.site_id);
  return `Buenas tardes, señor(a) ${e.leader_name || '[Nombre del líder]'},\n\nDe acuerdo con la conversación establecida y la disponibilidad informada, le confirmo que tendremos la sesión correspondiente a la actividad:\n\nActividad: ${taskName(e.activity_id)}\nEmpresa: ${c?.name || ''}\nSede: ${s?.name || ''}\nFecha: ${formatDate(e.event_date)}\nHora: ${e.event_time}\nDuración estimada: ${e.duration_minutes} minutos\n\nAgradezco tener en cuenta esta programación para el desarrollo de la actividad.\n\nCordialmente,\nYasbleidis López Rhenals\nFisioterapeuta · Especialista en Gerencia de la Seguridad y Salud en el Trabajo`;
}
function formatDate(d) { if (!d) return ''; return new Date(d + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
function googleCalendarUrl(e) {
  const c = state.companies.find(x => x.id === e.company_id), s = c?.sites.find(x => x.id === e.site_id);
  const start = eventDateTime(e), end = eventEnd(e);
  const fmt = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '00';
  const title = `${taskName(e.activity_id)} · ${c?.name || ''} · ${s?.name || ''}`;
  const details = `Sesión programada por Yasbleidis López Rhenals.\nLíder: ${e.leader_name || '-'}\nDisponibilidad informada: ${e.proposed_date || '-'} ${e.proposed_time || ''}\n${e.notes || ''}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${fmt(start)}/${fmt(end)}&details=${encodeURIComponent(details)}`;
}
async function saveSchedule(openGoogle, sendEmail) {
  if (!checkScheduleAvailability()) return toast('El horario seleccionado se cruza con otra actividad de tu agenda.');
  const companyId = $('scCompany').value, siteId = $('scSite').value, taskId = $('scTask').value, date = $('scDate').value, time = $('scTime').value;
  if (!date || !time) return toast('Define la fecha y hora de la sesión.');
  if (sendEmail && !$('scEmail').value.trim()) return toast('Ingresa el correo del líder para poder enviarle la notificación.');
  const { data: event, error } = await sb.from('schedule_events').insert({
    company_id: companyId, site_id: siteId, activity_id: taskId, event_date: date, event_time: time,
    duration_minutes: Number($('scDuration').value || 60), leader_name: $('scLeader').value.trim(), leader_email: $('scEmail').value.trim(),
    proposed_date: $('scProposedDate').value || null, proposed_time: $('scProposedTime').value || null,
    reminder_minutes: Number($('scReminder').value || 30), notes: $('scNotes').value.trim(), created_by: currentProfile?.id,
  }).select().single();
  if (error) {
    if (error.code === '23P01') return toast('Ese horario ya está ocupado por otra sesión en esta sede (bloqueado por la base de datos).');
    return toast('No se pudo guardar: ' + error.message);
  }
  if (sendEmail) { state.calendarSite.push(event); prepareScheduleEmail(event.id); }
  scheduleBrowserReminder(event); closeModal('scheduleModal'); await refreshAll();
  toast('Actividad programada correctamente en tu agenda.');
  if (openGoogle) window.open(googleCalendarUrl(event), '_blank');
}
function prepareScheduleEmail(id) {
  const e = state.calendarSite.find(x => x.id === id); if (!e) return;
  const subject = encodeURIComponent(`Confirmación de sesión – ${taskName(e.activity_id)}`);
  window.location.href = `mailto:${encodeURIComponent(e.leader_email || '')}?subject=${subject}&body=${encodeURIComponent(leaderEmailBody(e))}`;
}
function downloadICS(id) {
  const e = state.calendarSite.find(x => x.id === id); if (!e) return;
  const start = eventDateTime(e), end = eventEnd(e);
  const utc = d => d.toISOString().replace(/[-:]/g, '').replace('.000', '');
  const title = `${taskName(e.activity_id)}`;
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SG-SST Control//Agenda//ES\r\nBEGIN:VEVENT\r\nUID:${e.id}@sgsst-control\r\nDTSTAMP:${utc(new Date())}\r\nDTSTART:${utc(start)}\r\nDTEND:${utc(end)}\r\nSUMMARY:${title}\r\nDESCRIPTION:${(e.notes || 'Sesión programada SG-SST').replace(/\n/g, '\\n')}\r\nBEGIN:VALARM\r\nTRIGGER:-PT${Math.max(1, Number(e.reminder_minutes || 30))}M\r\nACTION:DISPLAY\r\nDESCRIPTION:Recordatorio de actividad SG-SST\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: 'text/calendar' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `actividad-${e.event_date}-${e.event_time.replace(':', '')}.ics`; a.click(); URL.revokeObjectURL(a.href);
}
async function deleteSchedule(id) { if (!confirm('¿Eliminar esta programación de tu agenda interna?')) return; const { error } = await sb.from('schedule_events').delete().eq('id', id); if (error) return toast(error.message); await refreshAll(); toast('Programación eliminada.'); }

// ---------------------------------------------------------------------------
// Detalle de una cita al hacer clic sobre el evento en el calendario visual:
// muestra la información completa y permite reenviar la citación (mismo
// correo de confirmación) al líder/coordinador sin tener que buscar el
// evento en la lista del día.
// ---------------------------------------------------------------------------
function showEventInfo(id) {
  const e = state.calendarSite.find(x => x.id === id);
  if (!e) return;
  const c = state.companies.find(x => x.id === e.company_id), s = c?.sites.find(x => x.id === e.site_id);
  $('eventInfoBody').innerHTML = `
    <p><b>Actividad:</b> ${taskName(e.activity_id)}</p>
    <p><b>Empresa / Sede:</b> ${c?.name || ''} · ${s?.name || ''}</p>
    <p><b>Fecha y hora:</b> ${formatDate(e.event_date)} · ${e.event_time} (${e.duration_minutes} min)</p>
    <p><b>Líder / coordinador:</b> ${e.leader_name || 'Sin líder registrado'}${e.leader_email ? ' · ' + e.leader_email : ''}</p>
    ${e.notes ? `<p><b>Observación:</b> ${e.notes}</p>` : ''}
  `;
  const resendBtn = $('eventInfoResendBtn');
  if (resendBtn) {
    resendBtn.style.display = e.leader_email ? 'inline-flex' : 'none';
    resendBtn.onclick = () => prepareScheduleEmail(e.id);
  }
  const deleteBtn = $('eventInfoDeleteBtn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => { await deleteSchedule(e.id); closeModal('eventInfoModal'); };
  }
  openModal('eventInfoModal');
}

function renderCalendar() {
  if (!$('calendarDate')) return;
  const date = $('calendarDate').value || today();
  const events = state.calendarSite.filter(e => e.event_date === date).sort((a, b) => a.event_time.localeCompare(b.event_time));
  $('calendarDayCount').textContent = `${events.length} sesión${events.length === 1 ? '' : 'es'}`;
  $('calendarDayList').innerHTML = events.length ? events.map(e => {
    const c = state.companies.find(x => x.id === e.company_id), s = c?.sites.find(x => x.id === e.site_id);
    return `<div class="dayEvent"><div class="time">${e.event_time} · ${e.duration_minutes} min</div><div class="title">${taskName(e.activity_id)}</div><div class="small">${c?.name || ''} · ${s?.name || ''}</div><div class="small">👤 ${e.leader_name || 'Sin líder registrado'}${e.leader_email ? ' · ' + e.leader_email : ''}</div><div class="small">🔔 Recordatorio: ${e.reminder_minutes >= 1440 ? '1 día antes' : e.reminder_minutes + ' min antes'}</div><div style="margin-top:10px;display:flex;gap:7px;flex-wrap:wrap"><button class="secondary" onclick='window.open(googleCalendarUrl(${JSON.stringify(e)}),"_blank")'>Google Calendar</button><button class="secondary" onclick="prepareScheduleEmail('${e.id}')">📩 Correo</button><button class="secondary" onclick="downloadICS('${e.id}')">🔔 .ics</button><button class="danger" data-requires-write onclick="deleteSchedule('${e.id}')">Eliminar</button></div></div>`;
  }).join('') : '<div class="calendarEmpty">No tienes sesiones programadas para este día. Tu agenda está disponible. ✨</div>';
  const all = state.calendarSite.filter(e => e.event_date === date);
  $('availabilityBox').innerHTML = `<div class="availabilityCard"><b>${formatDate(date)}</b><p class="small">${all.length ? 'Tienes ' + all.length + ' bloque(s) de tiempo ocupados en tu agenda interna.' : 'No tienes actividades programadas. Día disponible para nuevas sesiones.'}</p><div class="small"><b>Nota:</b> esta disponibilidad corresponde a las actividades registradas dentro de esta plataforma. Al usar "Google Calendar" puedes agregar la sesión a tu agenda personal.</div></div>`;
}

function scheduleBrowserReminder(e) {
  const when = eventDateTime(e).getTime() - Date.now() - Number(e.reminder_minutes || 30) * 60000;
  if (when > 0 && when < 2147483647 && 'Notification' in window && Notification.permission === 'granted') {
    setTimeout(() => new Notification('Recordatorio SG-SST', { body: `En ${e.reminder_minutes} minutos: ${taskName(e.activity_id)} · ${e.event_time}` }), when);
  }
}

// ---------------------------------------------------------------------------
// Calendario visual (FullCalendar) — día / semana / mes, con arrastre para
// reprogramar (respeta el mismo bloqueo de cruces que la agenda interna).
// ---------------------------------------------------------------------------
let fullCalendarInstance = null;
let pendingCalendarEvents = null;
function calendarSectionVisible() {
  const s = $('calendario');
  return !!s && s.offsetParent !== null;
}
// FullCalendar mide el ancho disponible al crearse. Si se instancia mientras
// la sección "Calendario" está oculta (display:none, porque el Dashboard es
// la sección activa por defecto), calcula un ancho de 0 y las columnas del
// mes quedan colapsadas para siempre (no basta con updateSize() después:
// hay que crearlo cuando el contenedor YA es visible). Por eso, si todavía
// no es visible, solo guardamos los eventos y esperamos a que el usuario
// entre a la sección (ver el hook en showSection, app.js).
function renderFullCalendar() {
  const el = $('fullCalendarEl');
  if (!el || typeof FullCalendar === 'undefined') return;
  const events = state.calendarSite.map(e => ({
    id: e.id,
    title: taskName(e.activity_id),
    start: `${e.event_date}T${e.event_time}`,
    end: eventEnd(e).toISOString(),
    color: e.google_calendar_synced ? '#2f8a63' : '#2f658e',
  }));
  if (!fullCalendarInstance && !calendarSectionVisible()) { pendingCalendarEvents = events; return; }
  if (!fullCalendarInstance) {
    fullCalendarInstance = new FullCalendar.Calendar(el, {
      locale: 'es',
      height: 'auto',
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
      initialView: 'dayGridMonth',
      editable: true,
      events,
      eventClick: info => { $('calendarDate').value = info.event.startStr.slice(0, 10); renderCalendar(); showEventInfo(info.event.id); },
      eventDrop: async info => {
        const newDate = info.event.startStr.slice(0, 10), newTime = info.event.startStr.slice(11, 16);
        const conflicts = scheduleConflicts(newDate, newTime, (info.event.end - info.event.start) / 60000, info.event.id);
        if (conflicts.length) { toast('No se puede mover ahí: se cruza con otra sesión.'); info.revert(); return; }
        const { error } = await sb.from('schedule_events').update({ event_date: newDate, event_time: newTime }).eq('id', info.event.id);
        if (error) { toast('No se pudo reprogramar: ' + error.message); info.revert(); return; }
        toast('Sesión reprogramada.'); await refreshAll();
      },
    });
    fullCalendarInstance.render();
  } else {
    fullCalendarInstance.removeAllEvents();
    fullCalendarInstance.addEventSource(events);
  }
}
