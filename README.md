# SG-SST Control

Plataforma de control de horas, actividades, evidencias, agenda e informes del proyecto SG-SST, ahora con base de datos real (Supabase) en lugar de `localStorage`, preservando el diseño y la navegación de la versión original.

Ver también:
- `docs/ARCHITECTURE.md` — por qué Supabase y no otra cosa
- `docs/ER-DIAGRAM.md` — diagrama entidad-relación
- `docs/TABLES.md` — qué guarda cada tabla

## Estructura del proyecto

```
sgsst-control/
├── index.html                  # Página única (SPA), mismo diseño de siempre
├── assets/
│   ├── css/app.css             # Estilos (sin cambios de fondo)
│   ├── img/logo-sst.png        # Logo institucional
│   └── js/
│       ├── config.example.js   # Plantilla de credenciales públicas (copiar a config.js)
│       ├── supabaseClient.js   # Cliente único de Supabase
│       ├── auth.js             # Login/logout real + protección de rutas
│       ├── app.js              # Lógica de la aplicación (dashboard, horas, evidencias, config)
│       ├── calendarView.js     # Agenda, conflictos, ICS, Google Calendar, FullCalendar
│       ├── reports.js          # Informes en pantalla + exportación PDF/Excel
│       └── migrate-localstorage.js  # Migración única desde la versión anterior
├── supabase/
│   ├── migrations/
│   │   ├── 0001_init_schema.sql
│   │   ├── 0002_functions_triggers.sql
│   │   ├── 0003_rls_policies.sql
│   │   └── 0004_storage.sql
│   └── seed.sql                # Empresas, sedes y actividades iniciales
├── scripts/
│   ├── seed-admin-user.mjs     # Crea el usuario Yasbleidis (Auth + perfil)
│   └── package.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── ER-DIAGRAM.md
│   └── TABLES.md
├── .env.example
└── .gitignore
```

## 1. Crear el proyecto en Supabase

1. Crea una cuenta gratuita en [supabase.com](https://supabase.com) y crea un nuevo proyecto.
2. En **Project Settings > API** copia:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (guárdala aparte, es secreta)
3. Copia `.env.example` a `.env` y pega esos tres valores.

## 2. Crear las tablas (elige una opción)

**Opción A — Panel de Supabase (más simple, sin instalar nada):**
Ve a **SQL Editor** en el panel de Supabase y ejecuta, en orden, el contenido de cada archivo:
```
supabase/migrations/0001_init_schema.sql
supabase/migrations/0002_functions_triggers.sql
supabase/migrations/0003_rls_policies.sql
supabase/migrations/0004_storage.sql
supabase/seed.sql
```

**Opción B — Supabase CLI (recomendada si vas a seguir versionando cambios):**
```bash
npm install -g supabase
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase db push        # aplica las migraciones de supabase/migrations/
psql "$(supabase db url)" -f supabase/seed.sql
```

## 3. Crear el usuario Yasbleidis (y cualquier otro usuario)

Esto NO se hace por SQL directo porque los usuarios viven en Supabase Auth:

```bash
cd scripts
npm install
cp ../.env.example ../.env   # si no lo habías hecho
# edita seed-admin-user.mjs y reemplaza el correo y la contraseña de ejemplo
node seed-admin-user.mjs
```

Para agregar más usuarios (por ejemplo un rol "lector" para un supervisor externo), repite el proceso cambiando los datos en `NEW_USER`, o crea el usuario desde el panel de Supabase (**Authentication > Users**) y luego inserta manualmente su fila en `profiles`.

## 4. Configurar el front-end

```bash
cp assets/js/config.example.js assets/js/config.js
```
Edita `assets/js/config.js` y coloca tu `SUPABASE_URL` y `SUPABASE_ANON_KEY` (los mismos valores del `.env`, la anon key SÍ está pensada para ir en el navegador).

## 5. Probar en tu computador

Como es un sitio 100% estático, cualquier servidor simple funciona, por ejemplo:
```bash
npx serve .
# o
python3 -m http.server 8080
```
Abre la URL que te indique y entra con el correo/contraseña que creaste en el paso 3.

## 6. Publicar en tu hosting actual

La plataforma sigue siendo un sitio estático, así que el mismo procedimiento del `README_INSTALACION.txt` original sigue sirviendo:

1. Sube **todo** el contenido de esta carpeta (incluyendo `assets/js/config.js` ya editado, pero **nunca** `.env` ni `scripts/`) a la carpeta pública de tu hosting (`public_html` o la carpeta del dominio).
2. Verifica que `index.html` quede directamente dentro de la carpeta pública.
3. Confirma que la estructura de carpetas se mantenga:
   ```
   index.html
   assets/css/app.css
   assets/js/*.js
   assets/js/config.js
   assets/img/logo-sst.png
   ```
4. En el panel de Supabase, en **Authentication > URL Configuration**, agrega la URL pública de tu hosting a la lista de "Redirect URLs" / "Site URL" permitidas.

No hay backend que desplegar ni servidor que mantener corriendo: todo el "servidor" es Supabase.

## 7. Migrar los datos de la versión anterior (una sola vez)

1. Publica y abre esta nueva versión en el mismo navegador/computador donde funcionaba la anterior.
2. Inicia sesión.
3. Ve a **Configuración > Migración de datos** y pulsa **"Migrar datos del navegador anterior"**.
4. Revisa el resumen que aparece (cuántas empresas, sedes, horas, evidencias y eventos se copiaron) antes de seguir usando la plataforma con normalidad.

## Seguridad — qué se implementó

- Autenticación real por correo/contraseña (Supabase Auth), ya no una cédula fija visible en el código.
- Protección de rutas: ninguna sección ni dato se muestra sin una sesión válida.
- Row Level Security en todas las tablas: la lectura/escritura depende del rol del usuario, no de lo que el navegador "decida" mostrar.
- Ninguna clave secreta vive en el código fuente: `SUPABASE_SERVICE_ROLE_KEY` solo se usa en `scripts/seed-admin-user.mjs`, ejecutado a mano en un computador de confianza, nunca en el navegador ni en el sitio publicado.
- `.env` y `assets/js/config.js` están en `.gitignore`: no se suben al repositorio.
- Validaciones de datos tanto en el formulario (JavaScript) como en la base de datos (constraints `check`, claves foráneas, y la restricción `EXCLUDE` que impide guardar sesiones de agenda cruzadas).
- Bloqueo real (a nivel de base de datos, no solo de interfaz) de nuevos registros de horas sobre actividades ya completadas.

## Qué se preservó del diseño y funcionalidad originales

Mismo layout, mismo menú lateral, mismos colores y componentes visuales, mismas 5 actividades fijas, misma lógica de bolsa de horas con arrastre mensual, mismo flujo de registrar horas / avances / evidencias / agenda / informes, y el mismo texto de correo de confirmación para el líder de la sede.

## Qué se corrigió respecto al prototipo anterior

- El progreso de cada actividad ya no es un porcentaje fijo inventado (0/55/100 según el estado); ahora se muestra siempre en horas acumuladas reales, con soporte opcional para meta de horas (`activity_targets`) si más adelante se define una.
- Las evidencias tipo archivo ahora se guardan de verdad (Supabase Storage); antes solo se guardaba el nombre del archivo y el contenido se perdía al recargar la página.
- Se eliminó un bloque de código muerto ("V7: AVANCES POR HORAS") que hacía referencia a formularios que no existen en la interfaz real — nunca llegó a usarse.
- Se agregó una alerta visible cuando todavía no se ha creado la bolsa de horas del mes en curso para la sede seleccionada.
- La detección de cruces de horario en la agenda ahora también se aplica a nivel de base de datos (antes solo se validaba en el navegador).
