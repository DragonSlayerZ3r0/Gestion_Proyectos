# Credenciales AWS SSO

## Perfil recomendado

Este proyecto debe usar AWS IAM Identity Center mediante el perfil:

```text
gestion-proyectos-dev
```

Datos del perfil:

- Cuenta AWS: `186281981036`
- Región: `us-east-1`
- SSO session: `bdr-fed`
- Portal SSO: `https://banrural.awsapps.com/start`
- Rol SSO: `aws-ps-admin-analitica-bdr`

## Configuración esperada

La configuración local de AWS CLI debe contener:

```ini
[sso-session bdr-fed]
sso_start_url = https://banrural.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile gestion-proyectos-dev]
sso_session = bdr-fed
sso_account_id = 186281981036
sso_role_name = aws-ps-admin-analitica-bdr
region = us-east-1
output = json
```

## Flujo operativo

Antes de cualquier acción AWS relevante:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Si falla por sesión vencida:

```bash
aws sso login --sso-session bdr-fed
```

Luego repetir la validación STS.

## Reglas para agentes

- No leer ni imprimir `~/.aws/credentials`.
- No pedir credenciales temporales pegadas en chat para el flujo normal.
- No guardar llaves, secretos ni tokens en el repositorio.
- Todos los comandos AWS CLI deben usar `--profile gestion-proyectos-dev --region us-east-1 --no-cli-pager` cuando aplique.
- Para Python/boto3 usar:

```python
import boto3

session = boto3.Session(profile_name="gestion-proyectos-dev", region_name="us-east-1")
```

## Perfil legacy

El perfil `186281981036_aws-ps-admin-analitica-bdr` fue usado inicialmente con credenciales STS temporales pegadas. Debe considerarse legacy y usarse solo como fallback temporal si el flujo SSO no está disponible.
