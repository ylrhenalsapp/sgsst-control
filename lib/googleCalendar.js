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
  let out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(out.error?.message || 'Google Calendar rechazó la creación del evento.');
  }

  // Google crea la sala de Meet de forma ASÍNCRONA: la respuesta del
  // insert/patch suele volver con conferenceData.createRequest.status
  // .statusCode "pending" y sin hangoutLink todavía — el evento SÍ queda
  // creado en el calendario, pero si nos quedamos solo con esta respuesta
  // el link de Meet sale vacío. Reconsultamos el evento varias veces, con
  // una pequeña espera entre cada intento, hasta que Google confirme
  // "success" (aparece el link) o hasta agotar los intentos.
  //
  // OJO: la primera versión de este archivo solo reintentaba cuando el
  // status venía en "pending" o vacío — si Google devolvía "failure" (o
  // cualquier otro valor no previsto) nos quedábamos sin link Y sin avisar
  // a nadie, porque la creación del EVENTO sí había salido bien (solo
  // fallaba el "add-on" de Meet). Ahora reintentamos siempre que sea
  // virtual y todavía no haya link, y si al final de los intentos sigue sin
  // aparecer, devolvemos meetLinkWarning con el motivo para que el correo /
  // la app puedan mostrarle a Yasbleidis por qué no llegó el enlace, en vez
  // de fallar en silencio.
  const extractMeetLink = ev => ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video')?.uri || null;
  let meetLink = extractMeetLink(out);
  let meetLinkWarning = null;
  if (isVirtual && !meetLink) {
    const MAX_ATTEMPTS = 6;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !meetLink; attempt++) {
      await new Promise(r => setTimeout(r, 750));
      const pollResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events/${out.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const polled = await pollResp.json().catch(() => ({}));
      if (!pollResp.ok) continue;
      out = polled;
      meetLink = extractMeetLink(polled);
      if (meetLink) break;
      // Si Google ya reportó "failure", no tiene sentido seguir
      // reintentando (no va a cambiar de opinión) — cortamos de una vez.
      if (polled.conferenceData?.createRequest?.status?.statusCode === 'failure') break;
    }
    if (!meetLink) {
      const finalStatus = out.conferenceData?.createRequest?.status?.statusCode;
      meetLinkWarning = finalStatus === 'failure'
        ? 'El evento se creó en Google Calendar, pero Google no pudo generar la videollamada de Meet para esta sesión.'
        : 'El evento se creó en Google Calendar, pero el enlace de Google Meet tardó más de lo esperado en generarse. Reenvía la citación en unos minutos para volver a intentarlo.';
    }
  }

  return { skipped: false, googleEventId: out.id, htmlLink: out.htmlLink, meetLink, meetLinkWarning };
}

module.exports = { googleEnvReady, getAccessToken, upsertCalendarEvent };
