# Arquitectura · SG-SST Control

## Resumen de la decisión

**Front-end:** HTML + CSS + JavaScript puro, sin framework y sin paso de compilación — exactamente como estaba, para no rehacer el diseño ni la navegación. Lo único que cambia es que `app.js` ahora llama a Supabase en lugar de a `localStorage`.

**Back-end / base de datos:** Supabase (Postgres administrado + Auth + Storage + API REST automática). Se confirma la inclinación que tenía el cliente por Supabase porque encaja bien con el tamaño real del proyecto:

- El modelo de datos (empresas, sedes, actividades, bolsas de horas, registros) es completamente relacional — Postgres es la herramienta natural, no una base NoSQL.
- Supabase Auth reemplaza el login inseguro (cédula fija dentro del JavaScript) por sesiones reales, sin tener que programar ni mantener un sistema de autenticación propio.
- Supabase Storage reemplaza el manejo de evidencias, que en el prototipo perdía el archivo real al recargar la página (solo guardaba el nombre).
- Row Level Security (RLS) resuelve permisos por rol (admin/consultor/lector) sin necesidad de escribir un servidor intermedio.
- El cliente JavaScript de Supabase (`supabase-js`) se consume con una etiqueta `<script>` común, igual que cualquier otra librería — no obliga a introducir React, Vue, Webpack ni ningún paso de build, cumpliendo el pedido explícito de no complicar el proyecto más de lo necesario.
- Tiene plan gratuito suficiente para el volumen de este proyecto (una consultora, un puñado de usuarios, unas pocas empresas/sedes).

**Alternativa considerada y descartada:** un backend propio (Node/Express + Postgres). Habría significado programar y desplegar un servidor aparte, manejar sesiones/JWT a mano, y escribir toda la capa de API que Supabase ya da lista — más piezas que mantener sin ningún beneficio funcional adicional para este caso. Se descarta por ir en contra del pedido explícito de "sin hacerlo innecesariamente complejo".

## Piezas nuevas y para qué sirven

| Pieza | Reemplaza / resuelve |
|---|---|
| Supabase Auth (email + contraseña) | El `if(cedula==='...')` fijo dentro del JavaScript |
| Row Level Security | La falta total de control de acceso a los datos |
| Postgres (`supabase/migrations/*.sql`) | El objeto `data` guardado en `localStorage` |
| Supabase Storage (bucket `evidencias`) | Los archivos de evidencia que se perdían al recargar |
| FullCalendar (CDN) | La agenda tipo lista por el calendario visual día/semana/mes con arrastre |
| jsPDF + SheetJS (CDN) | La exportación real a PDF/Excel (antes solo existía "Imprimir" del navegador) |
| `get_bag_summary()` (función SQL) | La lógica de arrastre de bolsa mensual, ahora en la base de datos, no solo en el navegador |
| `assets/js/migrate-localstorage.js` | Puente de un solo uso para traer los datos que ya existían en el navegador de Yasbleidis |

## Camino de crecimiento (sin romper nada hoy)

- **Correo real:** hoy se usa `mailto:` (cero infraestructura, cero secretos). El día que se quiera enviar automáticamente sin depender del cliente de correo del usuario, se puede añadir un envío server-side (por ejemplo con una Edge Function de Supabase + un proveedor como Resend) sin tocar el resto del sistema.
- **Integración real con Google Calendar (OAuth):** hoy se genera un enlace prellenado y un archivo `.ics` (sin necesidad de que el usuario autorice nada). El modelo de datos (`schedule_events.google_calendar_synced`) ya deja espacio para, más adelante, sincronizar de verdad vía OAuth si se decide dar ese paso.
- **Realtime:** Supabase permite suscribirse a cambios de la base de datos en vivo; no se activó porque no era un requisito, pero la arquitectura lo permite sin cambios estructurales si en el futuro se quiere un dashboard multi-dispositivo que se actualice solo.
- **Metas de horas por actividad:** la tabla `activity_targets` ya existe pero se deja vacía por defecto; si el cliente define en el futuro cuántas horas se esperan por actividad, el porcentaje de avance empieza a calcularse automáticamente sin cambiar el esquema.
