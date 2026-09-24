/**
 * Envía la citación de una sesión programada (Agenda) como un correo real
 * con un archivo .ics de invitación adjunto, usando Resend. Reemplaza el
 * antiguo flujo de mailto: que requería que Yasbleidis le diera "Enviar" a
 * mano y no dejaba nada reconocible como cita real en el calendario del
 * líder.
 *
 * Requiere la variable de entorno RESEND_API_KEY configurada en Vercel
 * (Project Settings → Environment Variables). Nunca se expone al navegador:
 * esta función corre en el servidor.
 *
 * Seguridad: exige un token de sesión válido de Supabase (el mismo con el
 * que el usuario ya inició sesión en la app) antes de enviar nada, para que
 * este endpoint no pueda usarse como relay de correo abierto por alguien
 * que solo tenga la URL.
 */

const { escapeHtml, emailShell, detailRow, detailsTable, calloutBox, BRAND } = require('../lib/emailTemplate');
const { upsertCalendarEvent } = require('../lib/googleCalendar');

const SUPABASE_URL = 'https://jxzoaswibkkqggiijwrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4em9hc3dpYmtrcWdnaWlqd3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MjcyMTIsImV4cCI6MjEwMzUwMzIxMn0.MgURAe8IWGMRanZbZGe-HlBxg76jYNTvnWlAUNrIQQU';
const FROM = 'SG-SST Control <notificaciones@yasbleidislopez.com>';
const REPLY_TO = 'contacto@yasbleidislopez.com';

function scheduleInviteBodyHtml(d, meetLink) {
  const isVirtual = d.modality === 'virtual';
  const rows = [
    detailRow('🧾', 'Actividad', d.activityName),
    detailRow('🏢', 'Empresa', d.companyName),
    detailRow(isVirtual ? '🎥' : '📍', 'Modalidad', isVirtual ? 'Virtual (Google Meet)' : `Presencial · ${d.siteName}`),
    detailRow('🗓️', 'Fecha', d.dateFormatted),
    detailRow('🕒', 'Hora', d.time),
    detailRow('⏱️', 'Duración', `${d.durationMinutes} minutos`),
  ];
  return `
    <p style="margin:0 0 14px;">Buenas tardes, señor(a) <b>${escapeHtml(d.leaderName)}</b>,</p>
    <p style="margin:0 0 20px;">De acuerdo con la conversación establecida y la disponibilidad informada, le confirmo que tendremos la sesión correspondiente a la siguiente actividad:</p>
    ${detailsTable(rows)}
    ${d.notes ? `<p style="margin:0 0 20px;"><b>Observación:</b> ${escapeHtml(d.notes)}</p>` : ''}
    ${isVirtual && meetLink
      ? calloutBox(`🎥 <b>Esta sesión es virtual.</b> Te llegará por separado una invitación de Google Calendar con el botón para unirte directamente a la videollamada. Enlace directo: <a href="${meetLink}" style="color:${BRAND.green};">${meetLink}</a>`)
      : calloutBox('📎 Este correo incluye un archivo de invitación adjunto y te llegará por separado una invitación de Google Calendar: ábrelos para agregar la sesión directamente a tu calendario y confirmar tu asistencia.')}
    <p style="margin:0 0 4px;">Agradezco tener en cuenta esta programación para el desarrollo de la actividad.</p>
    <p style="margin:22px 0 0;">Cordialmente,<br><b>Yasbleidis López Rhenals</b><br><span style="color:${BRAND.muted};font-size:13px;">Fisioterapeuta · Especialista en Gerencia de la Seguridad y Salud en el Trabajo</span></p>
  `;
}

// Fecha+hora locales (America/Bogota) -> "YYYY-MM-DDTHH:MM:SS" sin offset,
// tal como lo espera la Google Calendar API cuando se manda timeZone aparte.
function toLocalISO(dateStr, timeStr, addMinutes = 0) {
  const d = new Date(`${dateStr}T${timeStr}:00`);
  d.setMinutes(d.getMinutes() + addMinutes);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    res.status(500).json({ error: 'Falta configurar RESEND_API_KEY en Vercel.' });
    return;
  }

  try {
    // 1. Verificar que quien llama tiene una sesión válida de la app (mismo
    // token con el que el usuario ya inició sesión en Supabase Auth).
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      res.status(401).json({ error: 'No autenticado.' });
      return;
    }
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!userResp.ok) {
      res.status(401).json({ error: 'Sesión inválida o expirada.' });
      return;
    }

    // 2. Validar los datos recibidos desde el navegador.
    const { to, subject, text, ics, filename, details, eventDate, eventTime, durationMinutes, modality, googleEventId } = req.body || {};
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!to || !emailRe.test(to)) {
      res.status(400).json({ error: 'Correo del destinatario inválido.' });
      return;
    }
    if (!subject || !text || !ics) {
      res.status(400).json({ error: 'Faltan datos de la citación (subject/text/ics).' });
      return;
    }

    // 3. Crear (o actualizar) el evento en el calendario de Google de
    // Yasbleidis. Si la sesión es virtual, esto genera el enlace real de
    // Google Meet. Si las variables de entorno de Google todavía no están
    // configuradas, upsertCalendarEvent devuelve { skipped: true } y el
    // correo de citación se envía igual (sin bloquear por esto).
    let calendarResult = { skipped: true };
    let calendarWarning = null;
    if (eventDate && eventTime) {
      try {
        const isVirtual = modality === 'virtual';
        calendarResult = await upsertCalendarEvent({
          googleEventId: googleEventId || undefined,
          summary: subject,
          description: text,
          startISO: toLocalISO(eventDate, eventTime),
          endISO: toLocalISO(eventDate, eventTime, Number(durationMinutes || 60)),
          attendeeEmail: to,
          attendeeName: details?.leaderName,
          isVirtual,
          location: !isVirtual ? `${details?.siteName || ''} · ${details?.companyName || ''}` : undefined,
        });
      } catch (calErr) {
        calendarWarning = calErr.message || 'No se pudo crear el evento en Google Calendar.';
      }
    }
    const meetLink = calendarResult.meetLink || null;

    // Si es virtual y ya tenemos el link real de Meet, se lo agregamos
    // también al texto plano de respaldo (el HTML ya lo incluye más abajo).
    const textFinal = (modality === 'virtual' && meetLink)
      ? `${text}\n\n🎥 Enlace de Google Meet: ${meetLink}\n(También te llegará la invitación de Google Calendar con este mismo enlace.)`
      : text;

    // 4. Armar la versión bonita (HTML con logo y colores de marca) además
    // del texto plano de siempre, que queda como respaldo para clientes de
    // correo que no rendericen HTML.
    const html = details
      ? emailShell({
          badge: '📅 Confirmación de sesión',
          title: subject,
          bandColor: BRAND.green,
          bodyHtml: scheduleInviteBodyHtml(details, meetLink),
        })
      : undefined;

    // 5. Enviar vía Resend. El .ics va como adjunto con
    // content_type "method=REQUEST" (además de traer METHOD:REQUEST dentro
    // del propio archivo) para que Outlook/Gmail del líder la reconozcan
    // como una citación real, con opción de Aceptar/Rechazar. Esto queda
    // como respaldo/complemento de la invitación real que ya manda Google
    // Calendar cuando la integración está configurada.
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        text: textFinal,
        ...(html ? { html } : {}),
        attachments: [
          {
            filename: filename || 'citacion.ics',
            content: Buffer.from(ics, 'utf-8').toString('base64'),
            content_type: 'text/calendar; charset=UTF-8; method=REQUEST',
          },
        ],
      }),
    });

    const resendOut = await resendResp.json().catch(() => ({}));
    if (!resendResp.ok) {
      res.status(502).json({ error: resendOut.message || 'Resend rechazó el envío.' });
      return;
    }

    res.status(200).json({
      ok: true,
      id: resendOut.id,
      googleEventId: calendarResult.skipped ? null : calendarResult.googleEventId,
      meetLink,
      calendarSkipped: !!calendarResult.skipped,
      calendarWarning,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error inesperado enviando la citación.' });
  }
};
