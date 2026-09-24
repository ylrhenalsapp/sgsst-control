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

const SUPABASE_URL = 'https://jxzoaswibkkqggiijwrr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4em9hc3dpYmtrcWdnaWlqd3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MjcyMTIsImV4cCI6MjEwMzUwMzIxMn0.MgURAe8IWGMRanZbZGe-HlBxg76jYNTvnWlAUNrIQQU';
const FROM = 'SG-SST Control <notificaciones@yasbleidislopez.com>';
const REPLY_TO = 'contacto@yasbleidislopez.com';

function scheduleInviteBodyHtml(d) {
  const rows = [
    detailRow('🧾', 'Actividad', d.activityName),
    detailRow('🏢', 'Empresa', d.companyName),
    detailRow('📍', 'Sede', d.siteName),
    detailRow('🗓️', 'Fecha', d.dateFormatted),
    detailRow('🕒', 'Hora', d.time),
    detailRow('⏱️', 'Duración', `${d.durationMinutes} minutos`),
  ];
  return `
    <p style="margin:0 0 14px;">Buenas tardes, señor(a) <b>${escapeHtml(d.leaderName)}</b>,</p>
    <p style="margin:0 0 20px;">De acuerdo con la conversación establecida y la disponibilidad informada, le confirmo que tendremos la sesión correspondiente a la siguiente actividad:</p>
    ${detailsTable(rows)}
    ${d.notes ? `<p style="margin:0 0 20px;"><b>Observación:</b> ${escapeHtml(d.notes)}</p>` : ''}
    ${calloutBox('📎 Este correo incluye un archivo de invitación adjunto: ábrelo para agregar la sesión directamente a tu calendario y confirmar tu asistencia.')}
    <p style="margin:0 0 4px;">Agradezco tener en cuenta esta programación para el desarrollo de la actividad.</p>
    <p style="margin:22px 0 0;">Cordialmente,<br><b>Yasbleidis López Rhenals</b><br><span style="color:${BRAND.muted};font-size:13px;">Fisioterapeuta · Especialista en Gerencia de la Seguridad y Salud en el Trabajo</span></p>
  `;
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
    const { to, subject, text, ics, filename, details } = req.body || {};
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!to || !emailRe.test(to)) {
      res.status(400).json({ error: 'Correo del destinatario inválido.' });
      return;
    }
    if (!subject || !text || !ics) {
      res.status(400).json({ error: 'Faltan datos de la citación (subject/text/ics).' });
      return;
    }

    // 3. Armar la versión bonita (HTML con logo y colores de marca) además
    // del texto plano de siempre, que queda como respaldo para clientes de
    // correo que no rendericen HTML.
    const html = details
      ? emailShell({
          badge: '📅 Confirmación de sesión',
          title: subject,
          bandColor: BRAND.green,
          bodyHtml: scheduleInviteBodyHtml(details),
        })
      : undefined;

    // 4. Enviar vía Resend. El .ics va como adjunto con
    // content_type "method=REQUEST" (además de traer METHOD:REQUEST dentro
    // del propio archivo) para que Outlook/Gmail del líder la reconozcan
    // como una citación real, con opción de Aceptar/Rechazar.
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
        text,
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

    res.status(200).json({ ok: true, id: resendOut.id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error inesperado enviando la citación.' });
  }
};
