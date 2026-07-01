# Gestión de Proyectos

Plataforma interna para gestionar proyectos, tareas, accesos funcionales y el catálogo del Data Lake sobre AWS.

La aplicación ofrece una experiencia simple, clara y rápida. Su base modular permite a equipos internos coordinar proyectos, tareas, datos disponibles y permisos de acceso mediante flujos directos.

## Proposito

- Gestionar proyectos internos y sus tareas.
- Controlar accesos por usuario, modulo y proyecto.
- Mostrar solo los módulos habilitados para cada usuario.
- Integrar un catálogo funcional sobre Glue Catalog, DynamoDB y Athena.
- Mantener auditoría de cambios relevantes.

## Arquitectura esperada

- Frontend: Astro + **TypeScript vanilla**, con render imperativo y módulos de UI.
- Hosting: CloudFront sobre S3 privado.
- Autenticacion: Amazon Cognito.
- API: API Gateway con Lambda **Python 3.12** y router propio por registro.
- Datos operativos: DynamoDB.
- Catálogo técnico: Glue Catalog.
- Consultas controladas: Athena.
- Data Lake: S3.
- Infraestructura: AWS CDK (TypeScript).

> Stack tecnológico completo, responsabilidades y modelo de ejecución en [`docs/01_arquitectura_aws.md`](docs/01_arquitectura_aws.md#stack-tecnológico).

## Diagrama de arquitectura

La plataforma utiliza una arquitectura serverless por capas con **módulos enchufables**: interfaz Astro organizada como shell y módulos de UI por inyección de dependencias, adaptador HTTP en Lambda con **router por registro**, servicios de dominio, **un repositorio por dominio** e infraestructura CDK. Los puntos de extensión mantienen estable el núcleo al incorporar módulos — ver [`docs/21_guia_nuevo_modulo.md`](docs/21_guia_nuevo_modulo.md).

→ **[Abrir guía visual de arquitectura y runtime](docs/Guia%2002%20-%20Arquitectura%20y%20runtime.canvas)**

La guía muestra el flujo de una solicitud, los controles de identidad y autorización, la arquitectura modular de Lambda, los datos operativos, la ejecución asíncrona y el límite entre la cuenta app `186281981036` y el hub `396913696127`.

Detalle de arquitectura, capas y flujo local/publicación: [`docs/01_arquitectura_aws.md`](docs/01_arquitectura_aws.md) · [`docs/17_desarrollo_local_publicacion.md`](docs/17_desarrollo_local_publicacion.md)

## Documentacion

### Guías visuales

Estas guías funcionan como punto de entrada navegable a la documentación del proyecto.

1. [`Guía 01 - Mapa de documentación`](docs/Guia%2001%20-%20Mapa%20de%20documentacion.canvas): responde dónde encontrar cada decisión y separa fundamentos, diseño, dominios, operación y evolución.
2. [`Guía 02 - Arquitectura y runtime`](docs/Guia%2002%20-%20Arquitectura%20y%20runtime.canvas): muestra cómo fluye una solicitud desde el navegador hasta los datos y dónde se aplican autenticación, autorización y controles del Data Lake.
3. [`Guía 03 - Cambio a producción y evolución`](docs/Guia%2003%20-%20Cambio%20a%20produccion%20y%20evolucion.canvas): organiza implementación, validación, publicación, responsabilidades AWS, permisos cross-account y trabajo futuro.
4. [`Guía 04 - Desarrollo y publicación`](docs/Guia%2004%20-%20Desarrollo%20y%20publicacion.canvas): presenta el flujo desde el desarrollo local hasta la publicación y verificación en AWS.

Código de color común: azul para estructura o ejecución, rojo para controles obligatorios, verde para datos o estado confirmado y ámbar para antecedentes, pendientes o propuestas no implementadas.

### Ruta de lectura para desarrolladores

Si eres nuevo en el proyecto, lee en este orden:

1. Este `README.md` — visión general, URLs y comandos.
2. [`docs/00_contexto_general.md`](docs/00_contexto_general.md) — propósito, público, alcance y principios del producto.
3. [`docs/01_arquitectura_aws.md`](docs/01_arquitectura_aws.md) — cómo está armado (capas, servicios, flujos).
4. [`docs/18_servicios_y_runtime.md`](docs/18_servicios_y_runtime.md) — cómo se comporta en runtime: cada servicio AWS mapeado al código, sesión, cachés del catálogo y detalles no obvios.
5. [`docs/17_desarrollo_local_publicacion.md`](docs/17_desarrollo_local_publicacion.md) — cómo desarrollar localmente y publicar.
6. [`docs/12_guardrails.md`](docs/12_guardrails.md) — controles obligatorios de producto, seguridad y datos.
7. [`docs/21_guia_nuevo_modulo.md`](docs/21_guia_nuevo_modulo.md) — cómo agregar un módulo nuevo mediante los puntos de extensión del backend y frontend.
8. El doc del módulo que vayas a tocar (ver índice abajo: [07 catálogo](docs/07_catalogo_datalake.md), [08 proyectos y tareas](docs/08_proyectos_tareas.md), [09 administración](docs/09_admin_accesos.md)).

Para trabajar con infraestructura AWS, suma [`docs/14_permisos_aws_actuales.md`](docs/14_permisos_aws_actuales.md) y [`docs/16_credenciales_aws_sso.md`](docs/16_credenciales_aws_sso.md). El archivo [`AGENTS.md`](AGENTS.md) contiene las reglas equivalentes para agentes de IA.

### Índice completo

El contexto detallado vive en `docs/`:

- [`docs/00_contexto_general.md`](docs/00_contexto_general.md): objetivo, alcance y principios.
- [`docs/01_arquitectura_aws.md`](docs/01_arquitectura_aws.md): infraestructura y flujos tecnicos.
- [`docs/02_modulos_funcionales.md`](docs/02_modulos_funcionales.md): módulos esperados.
- [`docs/03_seguridad_accesos.md`](docs/03_seguridad_accesos.md): autenticacion, autorizacion y permisos.
- [`docs/04_modelo_dynamodb.md`](docs/04_modelo_dynamodb.md): modelo operacional.
- [`docs/05_api_backend.md`](docs/05_api_backend.md): estructura y contratos de API.
- [`docs/06_frontend_ux.md`](docs/06_frontend_ux.md): experiencia de usuario.
- [`docs/07_catalogo_datalake.md`](docs/07_catalogo_datalake.md): catalogo Glue, contexto funcional y Athena.
- [`docs/08_proyectos_tareas.md`](docs/08_proyectos_tareas.md): reglas de proyectos y tareas.
- [`docs/09_admin_accesos.md`](docs/09_admin_accesos.md): administracion de usuarios y accesos.
- [`docs/10_integraciones_aws.md`](docs/10_integraciones_aws.md): integraciones AWS.
- [`docs/11_fases_implementacion.md`](docs/11_fases_implementacion.md): roadmap inicial.
- [`docs/12_guardrails.md`](docs/12_guardrails.md): controles obligatorios de producto, seguridad, datos e implementación.
- [`docs/13_backlog_inicial.md`](docs/13_backlog_inicial.md): tareas iniciales de construccion.
- [`docs/14_permisos_aws_actuales.md`](docs/14_permisos_aws_actuales.md): perfil AWS validado, permisos encontrados y limitantes.
- [`docs/15_estado_implementacion.md`](docs/15_estado_implementacion.md): estado actual del primer corte, comandos y pendientes.
- [`docs/16_credenciales_aws_sso.md`](docs/16_credenciales_aws_sso.md): uso del perfil SSO para este proyecto.
- [`docs/17_desarrollo_local_publicacion.md`](docs/17_desarrollo_local_publicacion.md): arquitectura por capas, puertos, desarrollo local y publicación.
- [`docs/18_servicios_y_runtime.md`](docs/18_servicios_y_runtime.md): servicios AWS en contexto (servicio → código → configuración) y comportamiento en runtime (sesión, caché del catálogo, grafo heurístico, `config.json`).
- [`docs/19_paso_a_produccion.md`](docs/19_paso_a_produccion.md): manual de despliegue a producción — decisiones, procedimiento, inicialización de datos y checklist.
- [`docs/20_roadmap_data_driven.md`](docs/20_roadmap_data_driven.md): roadmap orientado a datos.
- [`docs/21_guia_nuevo_modulo.md`](docs/21_guia_nuevo_modulo.md): guía paso a paso para agregar un módulo nuevo (backend + frontend).

## Estado actual

Monorepo desplegado en `dev` (cuenta `186281981036`): frontend Astro, backend Lambda Python e infraestructura CDK TypeScript. Estado detallado y acumulativo en [`docs/15_estado_implementacion.md`](docs/15_estado_implementacion.md).

Módulos en producción (dev): **Inicio** (resumen operativo + catálogo + facturación AWS con Cost Explorer multi-cuenta), **Proyectos y tareas** (CRUD completo, Kanban, drag-and-drop), **Catálogo Data Lake** (sync de Glue, contexto funcional, grafo de relaciones) y **Administración** (gestión de usuarios). El backend y el frontend están organizados en **módulos enchufables** (ver `docs/21`).

- Frontend: `https://d269paz1z7q1g0.cloudfront.net/`
- API: `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/`
- Usuario inicial Cognito: `usr041100@banrural.com.gt` con cambio de contraseña inicial requerido.

## Comandos principales

```bash
npm install
npm run check
npm run dev
npm run infra:deploy
```

Desarrollo local:

- Frontend Astro: `http://127.0.0.1:4321/`.
- Backend: se ejecuta en la Lambda publicada del ambiente `dev`; la depuración utiliza CloudWatch Logs.
- API publicada dev: `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/`.
- Frontend publicado dev: `https://d269paz1z7q1g0.cloudfront.net/`.

Antes de cualquier acción AWS:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Después de desplegar infraestructura, publicar el frontend estático. El
`--exclude config.json` preserva el `config.json` runtime ya publicado (no se
versiona). Procedimiento completo y alternativas en [`docs/17_desarrollo_local_publicacion.md`](docs/17_desarrollo_local_publicacion.md):

```bash
cd frontend
pnpm build
aws s3 sync dist/ s3://gestion-proyectos-dev-frontend-186281981036 \
  --delete --profile gestion-proyectos-dev --exclude config.json
aws cloudfront create-invalidation --distribution-id E2K3CA110228B1 \
  --paths "/*" --profile gestion-proyectos-dev
```
