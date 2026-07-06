# 22 · Bitácora del proyecto

Registro **append-only** de decisiones no obvias, incidentes y cambios de rumbo — la dimensión temporal que los demás docs no capturan (ellos describen el presente; aquí queda el **por qué y el cuándo**). Cualquier agente que retome el proyecto debe leer AGENTS.md y luego esta bitácora.

**Reglas del formato:**
- Una entrada por evento, la más reciente **arriba**. Nunca se edita ni borra una entrada pasada (si algo quedó obsoleto, se agrega una entrada nueva que lo diga y enlace a la anterior).
- Formato: `## AAAA-MM-DD · tipo — título`. Tipos: `decisión` · `incidente` · `cambio-de-rumbo` · `estándar`.
- 3–5 líneas: qué pasó / qué se decidió, por qué (alternativas descartadas si las hubo) y enlace a los docs afectados.
- La escribe quien hace el cambio (humano o agente), como último paso del flujo de sincronización (docs → AGENTS.md → bitácora).

---

## 2026-07-06 · estándar — Responsive obligatorio como parte de "terminado"

El usuario señaló que ya varias veces tuvo que recordar verificar el responsive. Se elevó a **regla dura**: ninguna UI se da por terminada sin probarla en ~1280/~768/~390 px, preferiblemente con el preview real (no solo razonando el CSS). Quedó en AGENTS.md (definición de terminado), `docs/06` (regla #6) y memoria (feedback `responsive-verificar-siempre`, se recuerda cada sesión). Se creó `.claude/launch.json` (servidor `frontend-dev`) para poder verificar en vivo.

## 2026-07-06 · incidente — Responsive de la tabla configurable (overflow horizontal en móvil)

Al hacer la tabla de ancho fijo (`table-layout: fixed`, sección anterior), en móvil la tabla (~1150px) empujaba la página de lado en vez de scrollear dentro de su contenedor. Causa: `.projectTablePanel` es item de grid con `min-width: auto` → se expandía al contenido. Fix: `min-width: 0` en el panel (verificado en preview a 390px: panel 374px, scroll interno OK, sin overflow de página). Segundo hallazgo: mis primeros overrides `@media` no aplicaban porque estaban ANTES de las reglas base de la tabla en el archivo (misma especificidad → gana la más tardía); se movieron a un `@media` posterior. Ambas reglas quedaron documentadas en `docs/06` (reglas al construir UI). También: chips de Estado como tira con scroll lateral y dropdowns 2 por fila en teléfono.

## 2026-07-06 · decisión — Tabla de solicitudes configurable (filtros + columnas + anchos)

Se ampliaron los filtros y se hizo la tabla personalizable. Decisión de diseño (consultada, según estándares): **chips de Estado + dropdowns** para Tipo/Área/Responsable — se descartó "todo dropdown" (degradaba el filtro más común de 1 a 2 clics) y "filtros por columna estilo Excel" (choca con el clic-para-ordenar ya existente y es el más complejo). Se agregó: menú "Columnas" (mostrar/ocultar; "Solicitud" siempre visible) y **anchos arrastrables** (`table-layout: fixed` + colgroup + asa en el th; el texto se recorta con elipsis y ensanchar revela más — resuelve el "ver más de Última actividad"). Columnas y anchos se persisten en localStorage (`gp.projectTable.v1`), no en backend (por navegador es lo sensato para preferencias de vista). Todo frontend. Ver `docs/02_modulos_funcionales.md` y estándar en `docs/06`.

## 2026-07-06 · decisión — Se elimina el bloque "Miembros" duplicado del detalle

"Personas relacionadas" (izquierda) y "Miembros" (panel derecho) mostraban el MISMO dato (`project.members`) con dos nombres distintos — redundante y rompía la consistencia de vocabulario (#9). Además el selector de rol (Responsable/Miembro/Lector) del bloque "Miembros" **no gobernaba ningún permiso** (verificado: la autorización es por `roles` del perfil, no por rol de miembro) y sobrecargaba la palabra "Responsable", que ya existe como campo propio. Se quitó el bloque "Miembros" y su código muerto (`renderMemberRoleControl`, `updateProjectMember`, binding `data-member-role`, CSS `.memberRoleRow`/`.detailList`). Queda una sola lista ("Personas relacionadas") + el campo Responsable. El atributo `role` permanece inerte en los items; el endpoint PATCH /members queda sin uso. Ver `docs/08_proyectos_tareas.md`.

## 2026-07-06 · estándar — Convención icono/texto para acciones (editar=lápiz, borrar=papelera)

Los botones-palabra de los catálogos ("Corregir nombre del área", "Corregir", "Eliminar") hacían ruido y rompían la consistencia: el resto de la app ya edita con ícono de lápiz. Se formalizó la convención (estándar #5 en `docs/06`): editar → lápiz, borrar → papelera roja + confirmación, crear/acción primaria → texto visible; iconos siempre con tooltip (`title`/`aria-label`) para no volverlos gesto oculto. Se agregó `renderDeleteIconButton` en `app.ts` (junto a `renderEditIconButton`) y se aplicó a los catálogos de área y estado. Regla obligatoria para todo módulo nuevo (queda en AGENTS.md).

## 2026-07-06 · decisión — Estados de solicitud como catálogo vivo (con color y borrado protegido)

Los estados dejan de ser un enum fijo y pasan a catálogo vivo (`PROJECT_STATUS`), como las áreas: agregar/corregir/eliminar desde el selector. Dos decisiones (consultadas): (1) color de una **paleta fija** de ~8 tonos —no rueda libre— para mantener disciplina de color y que los estados se distingan de un vistazo; (2) **borrado protegido** —no se puede borrar un estado en uso; el backend avisa cuántas solicitudes lo tienen y pide reasignarlas—. Los 4 semilla (planned/active/paused/closed) se materializan al primer GET usando sus claves como id → las solicitudes existentes calzan sin migración (validado: 7 active, 2 planned/closed, 1 paused, 2 sin estado). Filtros de la tabla ahora derivados del catálogo. Ver `docs/02_modulos_funcionales.md`, `docs/04`, `docs/05`.

## 2026-07-06 · decisión — Seguimiento agrupado por día + hora discreta

Anticipando varias entradas por día, el seguimiento ahora se **agrupa por día** (la fecha va una vez como encabezado fijo, no repetida en cada renglón) y cada entrada muestra su **hora** de registro de forma muy discreta (aún más tenue que el autor, hora de Guatemala desde `createdAt`): `08:15 · GAD Morales, Saul`. Cambio solo de frontend (`createdAt` ya se exponía). Jerarquía visual coherente con los estándares: día > (hora · autor) > texto. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-06 · decisión — El seguimiento muestra su autor (+ NameDirectory compartido)

Cada entrada de seguimiento ahora muestra quién la registró, junto a la fecha y atenuado. El dato ya se guardaba (`createdBy` = correo del autor), solo no se exponía → cambio de visualización sin migración. Como el autor es un *usuario* (correo), no una *persona* del directorio, se resuelve a nombre real con Identity Center. Para no duplicar esa lógica (ya existía en `AthenaMonitorService._resolve_names`), se extrajo a `services/name_directory.py::NameDirectory` (segundo consumidor → extracción, no copy-paste); Athena ahora delega ahí y comparten la caché NAMEMAP. Fallback: nombre → correo → se omite. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-05 · cambio-de-rumbo — Nace la v2 multinube: Plataforma_Inteligencia

Se decidió que la plataforma evolucione a **multinube** (modelo Databricks/Foundry: núcleo portable + adaptadores por nube). Se creó el proyecto hermano `../Plataforma_Inteligencia` (repo git propio) como v2: primitivos portables (Postgres, contenedores/FastAPI, OIDC, Terraform), `core/` sin SDKs de nube (guardrail `check-portability.sh`) y módulos cloud-nativos como plugins. Plan: la v2 alcanza paridad primero EN AWS y reemplaza a esta v1; al arrancar su Fase 1, este proyecto pasa a solo-corrección-de-errores y lo nuevo nace allá. El código de aquí se reutiliza pieza por pieza (mapa en `Plataforma_Inteligencia/docs/03_mapa_reutilizacion.md`). Mientras tanto, este proyecto sigue operando con normalidad.

## 2026-07-05 · estándar — Guardado rápido: merge local + fin del N+1 + botón con estados

El "Guardar" de Solicitudes se sentía lento y ambiguo (¿guardó o presiono de nuevo?). Causa raíz: cada guardado recargaba TODO el workspace, y `GET /api/workspace` hacía 3 consultas DynamoDB por proyecto (N+1, ~31 consultas con 10 solicitudes). Fix: (1) el PATCH fusiona su respuesta en el estado local y repinta, sin recarga completa; (2) el backend trae miembros/tareas/seguimientos de TODOS los proyectos en 3 consultas globales (GSI `byEntityType`) y agrupa en memoria; (3) todo botón Guardar pasa a "Guardando…" deshabilitado al clic y "✓ Guardado" al confirmar. Se descartó la UI optimista (complejidad de reconciliación innecesaria con estas latencias). Quedó como estándar #11 en `docs/06_frontend_ux.md`.

## 2026-07-05 · decisión — Solicitudes clasificadas por "Área solicitante" (catálogo vivo)

Se agregó el campo `requestingAreaId` a las solicitudes con un catálogo de áreas creable desde el propio selector y **editable** (si se registra con error de escritura se corrige y todas las solicitudes lo reflejan, porque referencian por id). Nombre elegido: **"Área solicitante"** — se descartó "Gerencia" (se queda corto: "Recuperación de Cartera" no es gerencia) y "Área" a secas (ambiguo con el área que atiende). Rutas `POST /api/areas` y `PATCH /api/areas/{areaId}`; entityType `AREA`. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-05 · estándar — Bitácora creada + estándar anti scroll-hijacking

Se crea esta bitácora como memoria compartida multiagente (la memoria persistente de Claude Code es privada de ese agente; esto es portable a cualquier modelo). Mismo día: en maestro-detalle apilado, seleccionar una fila hace "peek" (scroll mínimo que deja ver el panel sin perder el listado) + chevron ›/▾ + destello del borde; el salto completo solo con clic en el chevron. Se descartó el auto-scroll total: un clic de selección no debe quitarle el viewport al usuario. Ver `docs/06_frontend_ux.md` (criterio 2) y `docs/Guia 05 - Estandares visuales y UX.canvas` (nueva guía visual de estándares).

## 2026-07-04 · incidente — Deploy colgado ~1 h por custom resource roto

`cdk deploy` se colgó en `InitialDataSeed`: la Lambda auxiliar de custom resources (`AWS679…`) llevaba rota desde 2026-06-17 porque **AWS migró solo su runtime node18→22** (`Cannot find module 'index'`) y CloudFormation espera 1 h fija la respuesta. El rol SSO no tiene `cloudformation:CancelUpdateStack`, así que se reparó la Lambda a mano (`update-function-code` con el asset de `cdk.out`) y el rollback cerró en segundos. Fix de raíz: CDK 2.114→2.261 + CLI 2.1129 (auxiliares en node24, gobernados por CFN). Ojo: `infra/` NO está en el workspace pnpm — `pnpm install` va DENTRO de `infra/`. Guía de diagnóstico en la memoria del incidente; flujo en `docs/17_desarrollo_local_publicacion.md`.

## 2026-07-04 · estándar — Todo deploy avisa a los usuarios conectados

`deploy.json` en el bucket del frontend (no-store): el frontend lo sondea cada 60 s y muestra un aviso discreto durante el despliegue y "Recargar" cuando cambia el buildId. `deploy-frontend.sh` lo maneja solo; deploys de backend/CDK se envuelven con `scripts/deploy-flag.sh start|done`. Motivo: usuarios activos veían comportamientos mixtos a mitad de un despliegue sin explicación. Ver `docs/17_desarrollo_local_publicacion.md`.

## 2026-07-04 · decisión — Rediseño de "Solicitudes" (antes Proyectos y tareas) + 10 estándares de UX

El módulo no resultaba intuitivo; se investigó y la clave fue: **los usuarios no conocen Trello/Asana pero todos conocen Excel** → tabla maestro-detalle en lugar de tarjetas/kanban como vista principal, una sola acción primaria, drag & drop solo como atajo. Se renombró la etiqueta a "Solicitudes" con campo `requestType` (project|report) — **las claves persistidas (`projects`, `tasks`) nunca se renombran, solo etiquetas** (regla general). Los 10 criterios quedaron como OBLIGATORIOS para todo módulo en `docs/06_frontend_ux.md`; módulo en `docs/08_proyectos_tareas.md`.

## 2026-07-04 · incidente — Módulo Proyectos "vacío" por lecturas DynamoDB sin paginar

Al crecer la tabla (items `ATHENA#EXEC`), los `scan/query` de una sola página dejaron de traer los proyectos → el módulo aparecía vacío sin error. Regla dura desde entonces: solo `_query_all`/`_scan_all`/`_query_entity_type` de `BaseRepository` (17 call sites corregidos), GSI `byEntityType` para listados globales, y guardrail ejecutable `scripts/check-dynamo-pagination.sh` dentro de `npm run check`. Ver `docs/04_modelo_dynamodb.md` y `docs/21_guia_nuevo_modulo.md`.

## 2026-07-03 · decisión — Escaneo incremental de Athena (94 s → ~3 s)

El escaneo del monitoreo Athena re-consultaba y re-parseaba todo el rango en cada corrida. Se pasó a arquitectura incremental: items por ejecución (`PK=ATHENA#EXEC`, lint precalculado, TTL 45 d) + cursor de ingesta con solape de 2 h + agregación solo desde DynamoDB. CloudTrail limita ~2 req/s (paralelizarlo no sirve); el paralelismo se aplicó a la API de Athena (8 hilos) y el lint se memoiza por SQL idéntico. Medido: completo 94 s, incremental 2.9 s. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-02 · estándar — Manifiesto único para módulos y pestañas (SOLID)

Módulos/pestañas nuevos se declaran SOLO en `backend/app/modules/manifest.py`: la matriz de Administración, defaults de alta y etiquetas se derivan solos (no se toca `admin.ts`). Mismo período: la clave `home` pasa a mostrarse como "Panel" — se evaluó renombrar claves en DynamoDB y se descartó (migración riesgosa sin beneficio); `_CURRENT_LABELS` impone la etiqueta vigente sobre copias guardadas. Ver `docs/02_modulos_funcionales.md` y `docs/09_admin_accesos.md`.

## 2026-06-25 · cambio-de-rumbo — Rutas nuevas ya NO se registran en el CDK

API Gateway pasó a catch-all `/api/{proxy+}`: una ruta nueva solo se agrega al router del backend. La regla anterior de doble registro (backend + CDK) quedó obsoleta desde esta fecha. Ver `docs/05_api_backend.md`.

## 2026-06 (fines) · decisión — LLM: GLM 5 on-demand en lugar de Claude/Bedrock AgentCore

Una SCP de la organización bloquea Claude y AgentCore en ambas cuentas (solo permite us-east-1/ca-central-1 y restringe modelos). Se descartó pelear la excepción y se adoptó GLM 5 on-demand vía Bedrock para sugerencias SQL y chat (permiso ya aplicado en el hub). Existe un agente clásico exploratorio en el hub (`agent-gad-analitica-bdr`) que NO está conectado a la plataforma. Ver `docs/10_integraciones_aws.md`.
