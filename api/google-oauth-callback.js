/**
 * Paso 2: Google redirige aquí después de que Yasbleidis autoriza el
 * acceso. Intercambia el "code" por un refresh_token (válido
 * indefinidamente mientras la app de Google Cloud esté publicada "En
 * producción") y lo muestra UNA sola vez para copiarlo a mano como la
 * variable de entorno GOOGLE_REFRESH_TOKEN en Vercel — igual que se hizo
 * con la API key de Resend. Este endpoint nunca guarda el token en ningún
 * lado: solo lo muestra en pantalla para copiar y pegar.
 */
function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
  <style>body{font-family:'Segoe UI',Arial,sans-serif;background:#eef3f7;padding:40px 16px;color:#20313f;}
  .box{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 6px 24px rgba(24,50,74,.08);}
  code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f7f9fb;padding:2px 6px;border-radius:4px;}
  textarea{width:100%;padding:12px;border-radius:8px;border:1px solid #dbe4ec;background:#f7f9fb;font-family:ui-monospace,Menlo,monospace;font-size:13px;box-sizing:border-box;}
  h1{font-size:18px;margin-top:0;}
  a{color:#248b65;}</style></head><body><div class="box">${bodyHtml}</div></body></html>`;
}

module.exports = async (req, res) => {
  const { code, error } = req.query || {};
  if (error) {
    res.status(400).send(page('Autorización cancelada', `<h1>Autorización cancelada</h1><p>Google reportó: <code>${error}</code>. Puedes intentarlo de nuevo visitando <a href="/api/google-oauth-start">/api/google-oauth-start</a>.</p>`));
    return;
  }
  if (!code) {
    res.status(400).send(page('Falta el código', `<h1>Falta el código de autorización</h1><p>Visita primero <a href="/api/google-oauth-start">/api/google-oauth-start</a>.</p>`));
    return;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send(page('Falta configuración', '<h1>Falta configurar GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Vercel.</h1>'));
    return;
  }
  const redirectUri = `https://${req.headers.host}/api/google-oauth-callback`;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }).toString(),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out.refresh_token) {
      res.status(400).send(page('No se recibió refresh token', `<h1>No se recibió un refresh_token</h1><p>${out.error_description || out.error || 'Intenta de nuevo desde /api/google-oauth-start. Si ya habías autorizado antes, primero quita el acceso en myaccount.google.com/permissions (busca el nombre de tu proyecto de Google Cloud) y vuelve a intentarlo.'}</p>`));
      return;
    }
    res.status(200).send(page('Conexión con Google Calendar lista', `
      <h1>✅ Conexión con Google Calendar lista</h1>
      <p>Copia este valor y pégalo en <b>Vercel → Project Settings → Environment Variables</b> como una variable nueva llamada <code>GOOGLE_REFRESH_TOKEN</code>. Luego guarda y vuelve a desplegar (Redeploy) para que quede activo:</p>
      <textarea rows="3" readonly onclick="this.select()">${out.refresh_token}</textarea>
      <p style="margin-top:16px;font-size:13px;color:#667789;">Por seguridad, cierra esta pestaña después de copiarlo — este valor no queda guardado en ningún lado por este endpoint.</p>
    `));
  } catch (err) {
    res.status(500).send(page('Error', `<h1>Error inesperado</h1><p>${err.message}</p>`));
  }
};
