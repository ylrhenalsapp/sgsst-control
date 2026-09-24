/**
 * Plantilla visual compartida para TODOS los correos automáticos de la app
 * (citaciones, y en adelante avisos de bolsa de horas, informes/cuenta de
 * cobro, etc.). Centralizar el "marco" (logo, colores, pie de página) aquí
 * evita repetir el mismo HTML/CSS en cada función de /api — cada una solo
 * arma el contenido propio y lo envuelve con emailShell().
 *
 * Vive fuera de /api a propósito: Vercel convierte cada archivo dentro de
 * /api en su propia función/ruta, así que un helper compartido no puede
 * vivir ahí (quedaría expuesto como un endpoint roto). Las funciones de
 * /api lo importan con require('../lib/emailTemplate').
 *
 * Usa los mismos colores de marca que la app (ver :root en
 * assets/css/app.css) y el logo real ya alojado en assets/img — nada de
 * imágenes en base64 dentro del correo: muchos clientes (Outlook de
 * escritorio en particular) no renderizan `data:` URIs en <img>, así que
 * todo se referencia por URL pública.
 */

const SITE_URL = 'https://gestiongeneral-ssgt.vercel.app';
const LOGO_URL = `${SITE_URL}/assets/img/logo-sst-header.png`;

const BRAND = {
  navy: '#18324a',
  navy2: '#274e70',
  green: '#248b65',
  green2: '#42a87d',
  aqua: '#dff3f1',
  amber: '#d49a32',
  red: '#c85a52',
  ink: '#20313f',
  muted: '#667789',
  line: '#dbe4ec',
  bg: '#eef3f7',
};

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// badge: texto corto en la franja de color bajo el logo (ej. "📅 Confirmación de sesión").
// bandColor: color de esa franja — permite distinguir de un vistazo el tipo de aviso
// (verde para citaciones, ámbar para avisos de bolsa de horas, navy para informes...).
// bodyHtml: el contenido específico de cada correo, ya armado por su función.
function emailShell({ badge, title, bodyHtml, bandColor }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(24,50,74,.08);font-family:'Segoe UI',Arial,sans-serif;">
  <tr>
    <td style="background:${BRAND.navy};padding:26px 30px;text-align:center;">
      <img src="${LOGO_URL}" width="180" alt="SST Asesorías y Consultorías" style="display:block;margin:0 auto;max-width:180px;width:180px;height:auto;border:0;">
    </td>
  </tr>
  <tr>
    <td style="background:${bandColor || BRAND.green};padding:13px 30px;text-align:center;">
      <span style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;">${escapeHtml(badge)}</span>
    </td>
  </tr>
  <tr>
    <td style="padding:32px 30px;color:${BRAND.ink};font-size:14px;line-height:1.65;">
      ${bodyHtml}
    </td>
  </tr>
  <tr>
    <td style="background:${BRAND.bg};padding:18px 30px;text-align:center;border-top:1px solid ${BRAND.line};">
      <p style="margin:0;font-size:12px;color:${BRAND.muted};font-family:'Segoe UI',Arial,sans-serif;">SST Asesorías y Consultorías · Yasbleidis López Rhenals</p>
      <p style="margin:4px 0 0;font-size:12px;color:${BRAND.muted};font-family:'Segoe UI',Arial,sans-serif;">Fisioterapeuta · Especialista en Gerencia de la Seguridad y Salud en el Trabajo</p>
      <p style="margin:10px 0 0;font-size:11px;color:${BRAND.muted};font-family:'Segoe UI',Arial,sans-serif;">Mensaje automático de SG-SST Control · <a href="mailto:contacto@yasbleidislopez.com" style="color:${BRAND.green};text-decoration:none;">contacto@yasbleidislopez.com</a></p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Fila de la tabla de detalles (ver scheduleInviteBodyHtml en la función que
// arma la citación) — se exporta porque los próximos correos (bolsa de
// horas, informes) van a necesitar el mismo tipo de tabla de datos.
function detailRow(icon, label, value) {
  return `<tr>
    <td style="padding:10px 14px;background:#f7f9fb;border-bottom:1px solid ${BRAND.line};font-size:13px;color:${BRAND.muted};white-space:nowrap;width:38%;font-family:'Segoe UI',Arial,sans-serif;">${icon} ${escapeHtml(label)}</td>
    <td style="padding:10px 14px;background:#f7f9fb;border-bottom:1px solid ${BRAND.line};font-size:13px;color:${BRAND.ink};font-weight:600;font-family:'Segoe UI',Arial,sans-serif;">${escapeHtml(value)}</td>
  </tr>`;
}

function detailsTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;border:1px solid ${BRAND.line};margin-bottom:20px;">${rows.join('')}</table>`;
}

function calloutBox(text, color) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.aqua};border-left:4px solid ${color || BRAND.green};border-radius:8px;margin-bottom:22px;">
    <tr><td style="padding:14px 16px;font-size:13px;color:${BRAND.ink};font-family:'Segoe UI',Arial,sans-serif;">${text}</td></tr>
  </table>`;
}

module.exports = { BRAND, escapeHtml, emailShell, detailRow, detailsTable, calloutBox, SITE_URL, LOGO_URL };
