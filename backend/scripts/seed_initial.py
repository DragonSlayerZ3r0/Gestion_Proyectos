import argparse
from datetime import datetime, timezone

import boto3


MODULES = [
    ("home", "Inicio"),
    ("projects", "Proyectos"),
    ("tasks", "Tareas"),
    ("catalog", "Catálogo"),
    ("admin", "Administración")
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed inicial para Gestión de Proyectos.")
    parser.add_argument("--table-name", required=True)
    parser.add_argument("--email", default="usr041100@banrural.com.gt")
    parser.add_argument("--profile", default="gestion-proyectos-dev")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()

    email = args.email.strip().lower()
    now = datetime.now(timezone.utc).isoformat()
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table_name)

    with table.batch_writer() as batch:
        batch.put_item(Item={
            "PK": f"USER#{email}",
            "SK": "PROFILE",
            "entityType": "USER",
            "email": email,
            "name": email,
            "status": "active",
            "roles": ["admin", "user"],
            "createdAt": now,
            "updatedAt": now
        })

        for module_key, label in MODULES:
            batch.put_item(Item={
                "PK": f"USER#{email}",
                "SK": f"MODULE#{module_key}",
                "entityType": "USER_MODULE",
                "moduleKey": module_key,
                "label": label,
                "enabled": True,
                "createdAt": now,
                "updatedAt": now
            })

        batch.put_item(Item={
            "PK": "SETTING#APP",
            "SK": "META",
            "entityType": "SETTING",
            "environment": "dev",
            "createdAt": now,
            "updatedAt": now
        })

    print(f"Seed completado para {email} en {args.table_name}.")


if __name__ == "__main__":
    main()
