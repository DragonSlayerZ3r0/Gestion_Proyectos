from typing import Any

import boto3

from repositories.athena_monitor import AthenaMonitorRepository

REGION = "us-east-1"
IDENTITY_STORE_ID = "d-90662bac01"


class NameDirectory:
    """Resuelve correos institucionales a nombres para mostrar, con caché en
    DynamoDB (compartida). Único lugar donde vive esta lógica: lo usan el
    monitoreo de Athena ("Consultas más pesadas") y el autor del seguimiento de
    Solicitudes. Solo consulta Identity Center por los correos que faltan en la
    caché → tras el primer resolve casi no hace llamadas."""

    def __init__(self, repository: AthenaMonitorRepository | None = None) -> None:
        self._db = repository or AthenaMonitorRepository()

    def resolve(self, actors: list[str]) -> dict[str, str]:
        """{correo -> nombre}. Los que no resuelven quedan fuera del mapa (quien
        llama decide el fallback: correo o guion)."""
        cache = self._db.get_name_map()
        missing = [a for a in dict.fromkeys(actors) if "@" in a and a not in cache]
        if missing:
            ids = boto3.client("identitystore", region_name=REGION)  # cuenta de la app
            for actor in missing:
                name = self._lookup_identity(ids, actor)
                if name:
                    cache[actor] = name
            self._db.put_name_map(cache)
        return cache

    def _lookup_identity(self, ids: Any, actor: str) -> str:
        """Nombre de un usuario por su userName (usrNNNNN@) o su email (nombre.apellido@)."""
        for path in ("userName", "emails.value"):
            try:
                uid = ids.get_user_id(
                    IdentityStoreId=IDENTITY_STORE_ID,
                    AlternateIdentifier={"UniqueAttribute": {"AttributePath": path, "AttributeValue": actor}},
                )["UserId"]
            except Exception:
                continue
            try:
                return ids.describe_user(IdentityStoreId=IDENTITY_STORE_ID, UserId=uid).get("DisplayName") or ""
            except Exception:
                return ""
        return ""
