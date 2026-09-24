/**
 * Integración con Google Calendar (API real) para que las citaciones que se
 * envían desde la Agenda queden creadas directamente en el calendario de
 * Gmail de Yasbleidis (ylrhenals@gmail.com) — sin que ella tenga que aceptar
 * nada manualmente — y, si la sesión es virtual, con un enlace real de
 * Google Meet generado automáticamente por Google y enviado también al
 * líder/cliente dentro de la invitación de calendario que Google le manda.
 *
 * Requiere tres variables de entorno en Vercel (Project Settings →
 * Environment Variables), nunca expuestas al navegador:
 *   GOOGLE_CLIENT_ID      - de un OAuth Client ID tipo "Web application"
 *   GOOGLE_CLIENT_SECRET  - del mismo OAuth Client ID
 *   GOOGLE_REFRESH_TOKEN  - obtenido una sola vez autorizando la cuenta de
 *                           Google de Yasbleidis en /api/google-oauth-start
 *
 * Si estas variables no están configuradas todavía, upsertCalendarEvent
 * devuelve { skipped: true } en vez de lanzar error, para que el envío del
 * correo de citación (Resend) siga funcionando aunque la integración con
 * Google Calendar no se haya terminado de configurar.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_ID = 'primary';
const TIME_ZONE = 'America/Bogota';

function googleEnvReady() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok || !out.access_token) {
    throw new Error(out.error_description || out.error || 'No se pudo renovar el token de acceso de Google. Puede que el refresh token haya sido revocado — vuelve a autorizar en /api/google-oauth-start.');
  }
  return out.access_token;
}

// Crea (o actualiza, si ya existe googleEventId) el evento en el calendario
// de Yasbleidis. Si isVirtual es true, le pide a Google que genere un
// Google Meet real (conferenceData.createRequest); Google entrega el link ya
// vinculado a esa sala. sendUpdates:'all' hace que Google le mande, además,
// la invitación de calendario de verdad (con botón Aceptar/Rechazar y el
// botón "Unirse con Google Meet") al correo del líder/cliente.
async function upsertCalendarEvent({ googleEventId, summary, description, startISO, endISO, attendeeEmail, attendeeName, isVirtual, location }) {
  if (!googleEnvReady()) return { skipped: true };

  const accessToken = await getAccessToken();
  const body = {
    summary,
    description,
    start: { dateTime: startISO, timeZone: TIME_ZONE },
    end: { dateTime: endISO, timeZone: TIME_ZONE },
    attendees: attendeeEmail ? [{ email: attendeeEmail, displayName: attendeeName || undefined }] : [],
    reminders: { useDefault: true },
  };
  if (!isVirtual && location) body.location = location;
  if (isVirtual) {
    body.conferenceData = { createRequest: { requestId: `sgsst-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }

  const isUpdate = !!googleEventId;
  const url = isUpdate
    ? `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events/${googleEventId}?sendUpdates=all&conferenceDataVersion=1`
    : `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?sendUpdates=all&conferenceDataVersion=1`;

  const resp = await fetch(url, {
    method: isUpdate ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(out.error?.message || 'Google Calendar rechazó la creación del evento.');
  }
  const meetLink = out.hangoutLink || (out.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video')?.uri || null;
  return { skipped: false, googleEventId: out.id, htmlLink: out.htmlLink, meetLink };
}

module.exports = { googleEnvReady, getAccessToken, upsertCalendarEvent };
