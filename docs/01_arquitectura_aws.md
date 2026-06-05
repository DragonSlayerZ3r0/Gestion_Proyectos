# Arquitectura AWS

## Arquitectura base

```text
Usuario
  -> CloudFront
  -> S3 privado con frontend Astro
  -> Cognito Hosted UI o flujo OIDC
  -> API Gateway
  -> Lambda Python
  -> DynamoDB
  -> Glue Catalog
  -> Athena
  -> S3 Data Lake
```

## Servicios utilizados

- Astro: frontend web.
- S3 privado: almacenamiento del build estatico.
- CloudFront: distribucion del frontend.
- Cognito: autenticacion.
- API Gateway: entrada HTTP segura para backend.
- Lambda Python: logica de negocio.
- DynamoDB: datos operativos, autorizacion funcional y contexto.
- Glue Catalog: metadata tecnica de bases, tablas y columnas.
- Athena: preview y consultas controladas.
- S3 Data Lake: datos fuente.
- CloudWatch: logs y metricas.
- IAM: permisos entre servicios.
- Lake Formation: control adicional opcional sobre datos.

## Flujo frontend a backend

1. El usuario abre la aplicacion desde CloudFront.
2. El frontend valida sesion con Cognito.
3. El frontend envia el JWT en cada llamada a API Gateway.
4. API Gateway valida el token con JWT Authorizer.
5. Lambda recibe identidad validada.
6. Lambda consulta DynamoDB para permisos funcionales.
7. Lambda ejecuta la accion permitida y devuelve respuesta estandar.

## Flujo login

1. El usuario inicia sesion con Cognito.
2. Cognito emite tokens.
3. El frontend conserva la sesion segun la estrategia definida.
4. El frontend llama `GET /api/me`.
5. Backend devuelve perfil funcional, modulos habilitados y permisos.

## Flujo API

Todas las operaciones deben pasar por API Gateway y Lambda. El frontend no debe acceder directamente a DynamoDB, Glue, Athena ni S3 Data Lake.

## Flujo consulta Data Lake

1. Frontend solicita catalogo o preview.
2. Lambda valida permisos funcionales en DynamoDB.
3. Lambda obtiene metadata tecnica desde Glue Catalog.
4. Lambda combina metadata tecnica con contexto funcional guardado en DynamoDB.
5. Para preview, Lambda ejecuta consulta Athena controlada.
6. Lambda devuelve datos limitados y seguros.

## Ambientes

- `dev`: desarrollo y pruebas locales.
- `test`: validacion integrada.
- `prod`: uso real.

Cada ambiente debe tener recursos, variables y permisos separados.
