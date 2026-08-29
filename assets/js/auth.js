/**
 * Autenticación real (reemplaza el "login()" de la versión anterior, que
 * solo comparaba la cédula escrita contra un texto fijo dentro del propio
 * JavaScript — cualquiera podía leer el código fuente y ver la cédula).
 *
 * Ahora: Supabase Auth (email + contraseña), sesión con token real, y la
 * página no muestra NINGÚN dato ni sección hasta confirmar que hay sesión
 * válida (protección de rutas en el propio cliente; la protección real de
 * los datos la dan las políticas RLS en la base de datos).
 */
let currentProfile = null;

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await onLoggedIn(session);
  } else {
    showLoginScreen();
  }
}

function showLoginScreen() {
  $('loginOverlay').style.display = 'flex';
  $('userTop').style.display = 'none';
  $('visualStatusStrip').style.display = 'none';
}

async function onLoggedIn(session) {
  const { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error || !profile) {
    $('loginError').textContent = 'Tu usuario no tiene un perfil asignado en la plataforma. Contacta al administrador.';
    $('loginError').style.display = 'block';
    await sb.auth.signOut();
    return;
  }

  currentProfile = profile;
  $('loginOverlay').style.display = 'none';
  $('userTop').style.display = 'flex';
  $('visualStatusStrip').style.display = 'block';
  $('loginError').style.display = 'none';

  const initials = profile.full_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const topAvatar = document.getElementById('topAvatar');
  const welcomeName = document.getElementById('welcomeName');
  const welcomeRole = document.getElementById('welcomeRole');
  if (topAvatar) topAvatar.textContent = initials;
  if (welcomeName) welcomeName.textContent = profile.full_name;
  if (welcomeRole) welcomeRole.textContent = profile.position_title || '';
  if (typeof renderMiniCalendar === 'function') renderMiniCalendar();

  applyRolePermissions(profile.role);

  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  if (typeof init === 'function') init();
}

// Oculta botones de escritura/eliminación para el rol "lector".
function applyRolePermissions(role) {
  document.body.dataset.role = role;
  if (role === 'lector') {
    document.querySelectorAll('[data-requires-write]').forEach(el => el.style.display = 'none');
  }
}

async function login() {
  const email = String($('loginEmail')?.value || '').trim();
  const password = String($('loginPassword')?.value || '');
  if (!email || !password) {
    $('loginError').textContent = 'Ingresa tu correo y tu contraseña.';
    $('loginError').style.display = 'block';
    return;
  }
  // Feedback inmediato al dar clic: antes el botón se quedaba "quieto" varios
  // segundos mientras se conectaba con el servidor, y eso hacía parecer que
  // la plataforma estaba trabada. Ahora se ve de inmediato que está entrando.
  const btn = $('loginBtn');
  const btnOriginalText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Ingresando…'; }
  $('loginError').style.display = 'none';
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $('loginError').textContent = 'Correo o contraseña incorrectos.';
      $('loginError').style.display = 'block';
      $('loginPassword').focus();
      return;
    }
    await onLoggedIn(data.session);
  } catch (e) {
    $('loginError').textContent = 'No se pudo conectar. Verifica tu conexión a internet e intenta de nuevo.';
    $('loginError').style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btnOriginalText; }
  }
}

async function logout() {
  await sb.auth.signOut();
  currentProfile = null;
  location.reload();
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') showLoginScreen();
});

document.addEventListener('DOMContentLoaded', checkSession);

// ---------------------------------------------------------------------------
// Campana de notificaciones y menú de cuenta (barra superior)
// ---------------------------------------------------------------------------
function toggleNotifPanel(force) {
  const p = document.getElementById('notifPanel'); if (!p) return;
  const open = typeof force === 'boolean' ? force : !p.classList.contains('show');
  p.classList.toggle('show', open);
}
document.addEventListener('click', e => {
  if (!e.target.closest('.notifWrap')) document.getElementById('notifPanel')?.classList.remove('show');
});
