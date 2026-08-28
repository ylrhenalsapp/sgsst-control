/**
 * Cliente único de Supabase para toda la aplicación.
 * Requiere que assets/js/config.js (ver config.example.js) se cargue ANTES
 * que este archivo, y que la librería supabase-js se cargue antes también
 * (ver el <script> de cdnjs/jsdelivr en index.html).
 */
if (!window.__SUPABASE_URL__ || !window.__SUPABASE_ANON_KEY__) {
  console.error(
    'Falta assets/js/config.js. Copia assets/js/config.example.js a ' +
    'assets/js/config.js y completa tus credenciales de Supabase.'
  );
}

const sb = window.supabase.createClient(
  window.__SUPABASE_URL__,
  window.__SUPABASE_ANON_KEY__
);
