# Seguridad y accesos

## Principio central

Cognito dice quien es el usuario. DynamoDB dice que puede hacer. Lambda aplica la seguridad real.

## Autenticacion

- Usar Amazon Cognito.
- Validar JWT con API Gateway JWT Authorizer.
- No aceptar llamadas anonimas a endpoints privados.
- No manejar contraseñas en la aplicación.

## Autorizacion funcional

La autorizacion debe vivir en DynamoDB y considerar:

- Roles globales.
- Permisos por modulo.
- Roles por proyecto.
- Relacion usuario-proyecto.
- Permisos sobre tablas o contexto de Data Lake cuando aplique.

## Validacion en Lambda

Cada Lambda debe validar permisos antes de ejecutar acciones. No basta con que el menu frontend oculte una opcion.

## Roles globales iniciales

- `admin`: administra accesos globales y auditoría.
- `user`: usuario funcional base.
- `project_owner`: administra proyectos donde tenga ese rol.

Evitar crear demasiados roles al inicio. Preferir permisos concretos por modulo y proyecto.

## Reglas de seguridad

- No exponer credenciales AWS.
- No usar S3 publico para el frontend.
- No permitir SQL libre desde frontend.
- No exponer todo el catalogo a todos los usuarios.
- Auditar cambios de permisos, proyecto, tarea, prioridad y contexto funcional.
