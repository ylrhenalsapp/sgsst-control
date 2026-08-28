# Diagrama entidad-relación · SG-SST Control

```mermaid
erDiagram
    PROFILES ||--o{ HOUR_RECORDS : "registra"
    PROFILES ||--o{ EVIDENCES : "carga"
    PROFILES ||--o{ SCHEDULE_EVENTS : "programa"
    PROFILES ||--o{ MONTHLY_BAGS : "asigna"
    PROFILES ||--o{ BAG_ADJUSTMENTS : "aprueba"
    PROFILES ||--o{ ACTIVITY_STATUS_HISTORY : "actualiza"

    COMPANIES ||--o{ SITES : "tiene"
    SITES ||--o{ MONTHLY_BAGS : "tiene por mes"
    SITES ||--o{ HOUR_RECORDS : "acumula"
    SITES ||--o{ EVIDENCES : "acumula"
    SITES ||--o{ SCHEDULE_EVENTS : "agenda"
    SITES ||--o{ ACTIVITY_STATUS_HISTORY : "historial"
    SITES ||--o{ ACTIVITY_TARGETS : "meta opcional"

    ACTIVITIES ||--o{ HOUR_RECORDS : "clasifica"
    ACTIVITIES ||--o{ EVIDENCES : "clasifica"
    ACTIVITIES ||--o{ SCHEDULE_EVENTS : "clasifica"
    ACTIVITIES ||--o{ ACTIVITY_STATUS_HISTORY : "historial"
    ACTIVITIES ||--o{ ACTIVITY_TARGETS : "meta opcional"

    MONTHLY_BAGS ||--o{ BAG_ADJUSTMENTS : "ampliaciones"

    PROFILES {
        uuid id PK
        text full_name
        text cedula
        text role
        text position_title
    }
    COMPANIES {
        uuid id PK
        text name
    }
    SITES {
        uuid id PK
        uuid company_id FK
        text name
    }
    ACTIVITIES {
        uuid id PK
        text name
        bool is_fixed
    }
    ACTIVITY_TARGETS {
        uuid site_id FK
        uuid activity_id FK
        numeric target_hours
    }
    ACTIVITY_STATUS_HISTORY {
        uuid id PK
        uuid site_id FK
        uuid activity_id FK
        text status
        timestamptz changed_at
    }
    MONTHLY_BAGS {
        uuid id PK
        uuid site_id FK
        date month
        numeric assigned_hours
    }
    BAG_ADJUSTMENTS {
        uuid id PK
        uuid monthly_bag_id FK
        numeric hours
        text reason
    }
    HOUR_RECORDS {
        uuid id PK
        uuid company_id FK
        uuid site_id FK
        uuid activity_id FK
        date record_date
        numeric hours
        numeric rate
        text status
    }
    EVIDENCES {
        uuid id PK
        uuid company_id FK
        uuid site_id FK
        uuid activity_id FK
        text link
        text storage_path
    }
    SCHEDULE_EVENTS {
        uuid id PK
        uuid company_id FK
        uuid site_id FK
        uuid activity_id FK
        date event_date
        time event_time
        int duration_minutes
    }
```

## Cómo leerlo

Una empresa (`companies`) tiene varias sedes (`sites`); cada sede tiene, mes a mes, una bolsa de horas (`monthly_bags`) que puede recibir ampliaciones (`bag_adjustments`) y que se consume mediante registros de horas (`hour_records`). Cada registro de horas queda ligado siempre a una empresa, una sede y una actividad del catálogo global (`activities`, las 5 fijas del proyecto más cualquier otra que se agregue).

El estado de cada actividad **por sede** (Pendiente / En proceso / Completada) no se guarda como un solo campo que se sobreescribe: se guarda como un historial completo (`activity_status_history`), para que quede trazabilidad de cada cambio. El estado "actual" es simplemente el último registro de ese historial (vista `v_activity_current_status`).

`activity_targets` es opcional: solo existe si de verdad se definió una meta de horas para una actividad en una sede concreta. Si no existe, el progreso de esa actividad se muestra únicamente como horas acumuladas, nunca como un porcentaje inventado.

`evidences` y `schedule_events` también se agrupan por empresa/sede/actividad. `schedule_events` no permite dos filas que se crucen en el tiempo para la misma sede (restricción `EXCLUDE` a nivel de base de datos, además de la validación que ya hace el front-end antes de guardar).
