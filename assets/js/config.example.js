/**
 * Plantilla de configuración pública del front-end.
 * ---------------------------------------------------------------------------
 * Copia este archivo a "assets/js/config.js" (ese nombre está en .gitignore
 * y NUNCA se sube al repositorio) y reemplaza los valores por los de tu
 * proyecto de Supabase (Project Settings > API).
 *
 * IMPORTANTE: la "anon key" está diseñada por Supabase para ser pública —
 * se usa siempre desde el navegador y por sí sola no da acceso a nada; el
 * acceso real lo controlan las políticas de Row Level Security (RLS)
 * definidas en supabase/migrations/0003_rls_policies.sql. Lo que NUNCA debe
 * ir aquí ni en ningún archivo del sitio publicado es la "service_role key"
 * (esa sí es secreta y solo se usa en scripts/seed-admin-user.mjs, en tu
 * computador).
 */
window.__SUPABASE_URL__ = 'https://TU-PROYECTO.supabase.co';
window.__SUPABASE_ANON_KEY__ = 'TU_ANON_KEY_AQUI';
