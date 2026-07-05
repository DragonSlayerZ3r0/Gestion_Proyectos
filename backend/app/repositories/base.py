import os
from typing import Any

import boto3


class BaseRepository:
    """Acceso compartido a la tabla única de DynamoDB. Los repos de cada dominio
    heredan de aquí; así el detalle de conexión vive en un solo lugar."""

    def __init__(self) -> None:
        self._table = boto3.resource("dynamodb").Table(os.environ["MAIN_TABLE_NAME"])

    # ── Lecturas SIEMPRE paginadas ────────────────────────────────────────────
    # REGLA: ningún repo llama `self._table.query(...)` ni `self._table.scan(...)`
    # directo — SIEMPRE `self._query_all(...)` / `self._scan_all(...)`.
    # DynamoDB devuelve máx. 1 MB por página (en scan, ANTES de aplicar el filtro):
    # una lectura de una sola página "funciona" con la tabla chica y un día
    # devuelve datos incompletos sin error alguno (así se "vació" Proyectos cuando
    # los items ATHENA#EXEC llenaron las primeras páginas del scan, 2026-07-03).
    # `scripts/check-dynamo-pagination.sh` (parte de `npm run check`) lo verifica.
    def _query_all(self, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            response = self._table.query(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                return items
            kwargs["ExclusiveStartKey"] = last_key

    def _query_entity_type(self, entity_type: str, extra_filter: Any = None,
                           **kwargs: Any) -> list[dict[str, Any]]:
        """Listado global por tipo de entidad vía el GSI `byEntityType` (lee SOLO
        los items de ese tipo, no la tabla completa). `extra_filter` (opcional)
        refina el resultado. Fallback: si el índice aún no está ACTIVO (recién
        agregado o stack recién creado, backfill en curso), degrada al scan
        paginado para no romper la vista."""
        from boto3.dynamodb.conditions import Attr, Key
        try:
            qkw = dict(kwargs)
            if extra_filter is not None:
                qkw["FilterExpression"] = extra_filter
            return self._query_all(
                IndexName="byEntityType",
                KeyConditionExpression=Key("entityType").eq(entity_type), **qkw)
        except Exception:
            filt = Attr("entityType").eq(entity_type)
            if extra_filter is not None:
                filt = filt & extra_filter
            return self._scan_all(FilterExpression=filt, **kwargs)

    def _scan_all(self, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        while True:
            response = self._table.scan(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                return items
            kwargs["ExclusiveStartKey"] = last_key

    def _update(self, key: dict[str, str], values: dict[str, Any], return_values: str = "ALL_NEW") -> dict[str, Any]:
        """UpdateItem genérico con alias `#campo` (maneja palabras reservadas como
        `role`/`status`/`location`). `values` ya debe traer lo que se quiere setear."""
        names: dict[str, str] = {}
        parts: list[str] = []
        expr_values: dict[str, Any] = {}
        for field, value in values.items():
            names[f"#{field}"] = field
            expr_values[f":{field}"] = value
            parts.append(f"#{field} = :{field}")
        response = self._table.update_item(
            Key=key,
            UpdateExpression=f"SET {', '.join(parts)}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=expr_values,
            ReturnValues=return_values,
        )
        return response.get("Attributes", {})
