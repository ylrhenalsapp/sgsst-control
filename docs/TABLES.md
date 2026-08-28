# Documentación de tablas · SG-SST Control

Todas las tablas viven en el esquema `public` de Postgres (Supabase). El SQL exacto está en `supabase/migrations/`.

## `profiles`
Usuarios de la plataforma. Extiende `auth.users` (Supabase Auth) con los datos que la interfaz necesita mostrar.

| Columna | Tipo | Notas |
|---|---|---|
| id | uuid (PK) | = `auth.users.id` |
| full_name | text | Nombre mostrado en la barra superior |
| cedula | text | Solo informativo, ya no se usa para iniciar sesión |
| role | text | `admin` \| `consultor` \| `lector` — controla los permisos (RLS) |
| position_title | text | Cargo/rol profesional mostrado en la interfaz |

## `companies`
Empresas cliente (VEOLIA AGUAS DE MONTERÍA, AGUAS DE LA SABANA, y las que se agreguen).

## `sites`
Sedes de cada empresa (Montería, Corozal, Sincelejo, …). `unique(company_id, name)`.

## `activities`
Catálogo global de actividades. Incluye las 5 actividades fijas del proyecto (`is_fixed = true`) y cualquier actividad adicional que se cree desde Configuración.

## `activity_targets`
Meta de horas **opcional** por combinación sede+actividad. Si no hay fila para una sede/actividad, el progreso de esa actividad se reporta solo como horas acumuladas (nunca un porcentaje inventado). Si existe, `get_activity_progress()` calcula `horas acumuladas / target_hours`.

## `activity_status_history`
Historial completo (append-only) del estado de cada actividad por sede: `Pendiente` → `En proceso` → `Completada`. Nunca se borra ni se sobreescribe una fila; el estado "actual" es el más reciente (`v_activity_current_status`). Esto da la trazabilidad completa que pedía el proyecto.

**Regla de negocio clave:** una vez que el estado más reciente de una actividad en una sede es `Completada`, el trigger `trg_block_hours_on_completed` impide insertar nuevos `hour_records` para esa combinación sede/actividad, sin importar quién lo intente ni desde qué cliente.

## `monthly_bags`
Bolsa de horas asignada a una sede en un mes calendario concreto (`month` = día 1 del mes). Un registro por sede y mes (`unique(site_id, month)`).

## `bag_adjustments`
Horas adicionales agregadas a la bolsa de un mes ya existente, con motivo y trazabilidad (quién, cuándo, por qué). Nunca modifican `monthly_bags.assigned_hours` directamente — se sitúan aparte para no perder el historial de ampliaciones, igual que en el prototipo original (`additionalLog`).

**Cálculo del saldo:** la función `get_bag_summary(site_id, mes)` replica en SQL la lógica que ya existía en JavaScript: `disponible = asignadas + adicionales + saldo_del_mes_anterior − usadas`, y el saldo de un mes se calcula recursivamente a partir del mes anterior (arrastre indefinido mientras haya bolsas creadas).

## `hour_records`
Cada fila es una jornada de horas ejecutada: empresa, sede, actividad, fecha, horas, **tarifa fija de ese registro** (no cambia si luego se actualiza la tarifa general), estado y notas. `source` distingue si vino de "Registrar horas" (`manual`), de "Registrar avance" (`avance`) o de la migración (`migracion`).

## `evidences`
Evidencia de una actividad: un enlace externo (Drive, OneDrive, SharePoint, …), un archivo real subido al bucket privado `evidencias` de Supabase Storage (`storage_path`), o ambos.

## `schedule_events`
Sesiones programadas en la agenda interna de Yasbleidis. Incluye disponibilidad informada por el líder, disponibilidad definida internamente, recordatorio, y una restricción `EXCLUDE` que impide guardar dos sesiones que se crucen en horario **para la misma sede**, a nivel de base de datos (además de la validación previa en el formulario).

## `app_settings`
Tabla clave/valor genérica para configuración global simple (por ahora solo `default_rate`, la tarifa por hora sugerida para nuevos registros).

## Vistas y funciones

| Nombre | Tipo | Qué hace |
|---|---|---|
| `v_activity_current_status` | vista | Último estado de cada (sede, actividad) según `activity_status_history` |
| `get_bag_summary(site_id, mes)` | función | Resumen completo de la bolsa de un mes, con arrastre recursivo |
| `get_activity_progress(site_id, activity_id)` | función | Horas acumuladas + % real solo si hay meta definida |
| `current_user_role()` | función | Helper usado por las políticas RLS |
