# Módulos funcionales

## Principio de menú dinámico

Cada usuario solo ve los módulos que tiene habilitados. Ocultar un módulo en frontend mejora la experiencia, pero no reemplaza la validación obligatoria de permisos en Lambda.

## Inicio

Pantalla principal con resumen de proyectos, tareas asignadas, accesos disponibles y actividad relevante.

### Estado implementado

Dashboard con tres bloques (`renderHome` en `frontend/src/scripts/app.ts`, Chart.js cargado bajo demanda desde CDN):

1. **Resumen operativo**: totales de proyectos, tareas y personas; dona de tareas por estado y barra de proyectos por estado. Endpoint `GET /api/home/summary` (módulo `home`).
2. **Resumen de catálogo**: cantidad de bases, tablas y tamaño total del data lake (de las stats cacheadas por el sync), más las bases más grandes.
3. **Costos AWS** (solo rol `admin`): selector de **cuenta** (186281981036 app / 396913696127 hub) y de **periodo**; tarjetas de Uso/Créditos/Soporte/Impuestos/Neto, barra de costo por servicio (top 10), línea de tendencia diaria y créditos por servicio. Endpoint `GET /api/home/costs?account=&start=&end=` (`HomeService`, `backend/app/services/home.py`).

**Acceso a costos (Cost Explorer)**:
- Cuenta app (186281981036): el rol de la Lambda tiene `ce:GetCostAndUsage` directo.
- Cuenta hub (396913696127): la Lambda hace `sts:AssumeRole` al rol `gestion-proyectos-cost-reader` del hub (creado por `scripts/grant-hub-cost-explorer.sh`), que tiene `ce:Get*`. Cada cuenta tiene su Cost Explorer independiente (el hub no es la pagadora de la app).
- Las consultas a CE cuestan ~$0.01 por solicitud (cada carga del bloque hace 4 → ~$0.04), así que el resultado se cachea en DynamoDB (`HOME#COSTS`, clave `cuenta#inicio#fin`).
- **TTL diferenciado** (`_ttl_for_period`): los **meses cerrados** (su fecha fin ya pasó) no cambian → caché **30 días**; el **mes en curso** → caché **8 h**, alineado con que AWS solo refresca Cost Explorer ~3 veces al día. Así los meses históricos se consultan una sola vez y el mes actual no se re-consulta sin necesidad.
- La llamada a CE es **bajo demanda** (al abrir el bloque o cambiar cuenta/periodo), nunca en segundo plano. El item guarda `fetchedAt`; el dashboard muestra la fecha/hora absoluta de actualización para que los admin no refresquen por gusto.
- Botón **"Actualizar ahora"** (`?force=1`): salta el caché y vuelve a consultar AWS, con confirmación que advierte el costo. Útil cuando se necesita el dato más reciente del mes en curso.
- Todas las cifras viajan como string (DynamoDB no acepta float).

## Proyectos y tareas

Módulo operativo principal para crear, editar, consultar y administrar proyectos, tareas y personas asignadas desde una sola pantalla.

Aunque los permisos técnicos puedan existir como `projects` y `tasks`, el frontend debe presentarlos como una sola entrada: `Proyectos y tareas`. No se debe obligar al usuario a cambiar de ventana para crear o revisar tareas del proyecto activo.

Debe permitir responsables, estado, descripción, usuarios asociados, tareas por proyecto, prioridades, fechas, comentarios, movimiento Kanban simple y relación con tablas del Data Lake cuando aplique.

## Catálogo Data Lake

Módulo para explorar bases, tablas y columnas permitidas. Debe combinar metadata técnica de Glue Catalog con contexto funcional guardado en DynamoDB.

## Tableros

Módulo futuro para vistas resumidas, indicadores y paneles internos.

## Solicitudes

Módulo futuro para solicitudes de acceso, cambios, revisiones o trabajo asociado a proyectos y datos.

## Administración

Módulo para usuarios con permisos administrativos. Inicialmente gestiona accesos globales, módulos por usuario, activación funcional y auditoría.
