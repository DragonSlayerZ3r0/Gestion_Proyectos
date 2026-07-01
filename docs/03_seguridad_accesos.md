# Seguridad y accesos

## Principio central

Cognito dice quien es el usuario. DynamoDB dice que puede hacer. Lambda aplica la seguridad real.

## Autenticacion

- Usar Amazon Cognito.
- Validar JWT con API Gateway JWT Authorizer.
- Exigir identidad autenticada en todos los endpoints privados.
- Delegar el manejo de credenciales y contraseñas a Amazon Cognito.

## Autorizacion funcional

La autorizacion debe vivir en DynamoDB y considerar:

- Roles globales.
- Permisos por modulo.
- Roles por proyecto.
- Relacion usuario-proyecto.
- Permisos sobre tablas o contexto de Data Lake cuando aplique.

## Validacion en Lambda

Cada operación valida permisos en Lambda antes de ejecutar acciones. El menú frontend refleja esa autorización para construir la experiencia visible.

## Roles globales iniciales

- `admin`: administra accesos globales y auditoría.
- `user`: usuario funcional base.
- `project_owner`: administra proyectos donde tenga ese rol.

El modelo inicial utiliza pocos roles globales y permisos concretos por módulo y proyecto.

## Reglas de seguridad

- Obtener credenciales AWS mediante perfiles SSO y mantenerlas fuera del repositorio y la interfaz.
- Servir el frontend mediante CloudFront con un bucket S3 privado.
- Ejecutar consultas Athena definidas y controladas por servicios backend.
- Calcular la visibilidad del catálogo según módulos, proyectos y permisos funcionales.
- Auditar cambios de permisos, proyecto, tarea, prioridad y contexto funcional.
