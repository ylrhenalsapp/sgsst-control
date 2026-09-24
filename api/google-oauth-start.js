/**
 * Paso 1 del proceso de conexión ÚNICA con Google Calendar: redirige al
 * formulario de permisos de Google para que Yasbleidis autorice, con su
 * propia cuenta (ylrhenals@gmail.com), que esta app pueda crear eventos en
 * su calendario. Solo hay que visitarlo UNA vez (o de nuevo si alguna vez
 * hay que regenerar el token). El resultado (refresh token) se recoge en
 * /api/google-oauth-callback.
 */
module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Falta configurar GOOGLE_CLIENT_ID en Vercel antes de iniciar este paso.');
    return;
  }
  const redirectUri = `https://${req.headers.host}/api/google-oauth-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/calendar.events',
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
};
