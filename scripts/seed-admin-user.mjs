/**
 * SG-SST Control · Creación del usuario inicial (Yasbleidis López Rhenals)
 * ---------------------------------------------------------------------------
 * Este script se ejecuta UNA SOLA VEZ, en tu computador (nunca en el
 * navegador ni en el sitio publicado), porque usa la SERVICE ROLE KEY de
 * Supabase, que tiene permisos totales y NUNCA debe exponerse al público.
 *
 * Uso:
 *   1. Copia .env.example a .env y completa SUPABASE_URL y
 *      SUPABASE_SERVICE_ROLE_KEY (Project Settings > API en Supabase).
 *   2. Instala la dependencia:  npm install @supabase/supabase-js dotenv
 *   3. Ejecuta:                 node scripts/seed-admin-user.mjs
 *
 * El script crea el usuario en Supabase Auth con el correo y contraseña
 * indicados abajo (cámbialos por unos reales antes de ejecutar) y su fila
 * correspondiente en public.profiles.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en tu archivo .env');
  process.exit(1);
}

// ---- AJUSTA ESTOS DATOS ANTES DE EJECUTAR --------------------------------
const NEW_USER = {
  email: 'yasbleidis@example.com',      // <-- reemplaza por el correo real
  password: 'CambiaEstaClaveSegura123!', // <-- reemplaza por una clave real
  full_name: 'Yasbleidis López Rhenals',
  cedula: '1067886254',
  role: 'admin',
  position_title: 'Fisioterapeuta · Especialista en Gerencia de la Seguridad y Salud en el Trabajo',
};
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email: NEW_USER.email,
    password: NEW_USER.password,
    email_confirm: true,
  });

  if (createError) {
    console.error('No se pudo crear el usuario en Supabase Auth:', createError.message);
    process.exit(1);
  }

  const userId = created.user.id;

  const { error: profileError } = await supabase.from('profiles').insert({
    id: userId,
    full_name: NEW_USER.full_name,
    cedula: NEW_USER.cedula,
    role: NEW_USER.role,
    position_title: NEW_USER.position_title,
  });

  if (profileError) {
    console.error('Usuario creado en Auth, pero falló el perfil:', profileError.message);
    process.exit(1);
  }

  console.log('Usuario y perfil creados correctamente.');
  console.log('  Email:', NEW_USER.email);
  console.log('  UUID :', userId);
  console.log('Guarda estas credenciales en un lugar seguro (no en el código).');
}

main();
