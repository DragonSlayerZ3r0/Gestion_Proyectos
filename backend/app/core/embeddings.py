"""Índice de embeddings semántico — GENÉRICO y portable (core, cero acoplamiento).

Este módulo NO importa nada del proyecto (solo boto3 + stdlib): está pensado para
copiarse tal cual a plataformas hermanas. Toda la parametrización vive en
`EmbeddingConfig`; los consumidores instancian `EmbeddingIndex` y usan
`index()` / `search()` / `delete()`. No conoce solicitudes, seguimientos ni ningún
dominio concreto — solo (docId, texto, metadatos).

Almacenamiento: DynamoDB single-table (la misma tabla del proyecto, u otra). Cada
vector es un item:
    PK          = EMBED#{namespace}#{docId}
    SK          = EMBED#{namespace}
    entityType  = EMBEDDING#{namespace}     ← el GSI byEntityType devuelve SOLO
                                              ese segmento en UNA query (proyección
                                              ALL, así que trae el vector completo).
El vector va como Binary (float32 empacado con struct: 256 dims = 1 KB). La
búsqueda es coseno por fuerza bruta en memoria: a escala de miles de items son
décimas de segundo, y el mismo dato migra a un índice real (S3+numpy, OpenSearch)
sin tocar a los consumidores — solo cambiaría el adapter VectorStore.

Segmentación: `namespace` separa dominios dentro de una misma tabla (p. ej.
"solicitud" y "seguimiento" no se mezclan); otra plataforma con otra tabla solo
cambia `table_name`. Credenciales: dos proveedores inyectables independientes —
uno para Bedrock (esta app asume el rol del hub; una hermana con Bedrock propio no
pasa ninguno) y otro para la tabla (por defecto, credenciales del entorno).
"""
import json
import struct
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Callable, Optional

import boto3
from boto3.dynamodb.conditions import Key

# Firma de un proveedor de sesión boto3 (permite assume-role u otra cuenta).
SessionProvider = Callable[[], "boto3.Session"]


@dataclass(frozen=True)
class EmbeddingConfig:
    """Toda la parametrización del índice. Lo único que un consumidor arma."""
    table_name: str
    namespace: str
    model_id: str = "amazon.titan-embed-text-v2:0"
    dimensions: int = 256
    region: str = "us-east-1"
    top_k: int = 40
    entity_index: str = "byEntityType"
    entity_attr: str = "entityType"
    max_input_chars: int = 8000          # recorte defensivo (Titan tope ~8K tokens)
    # Sesión para invocar Bedrock (Titan). None → credenciales del entorno.
    # En esta app se inyecta una que asume el rol del hub (igual que LlmService).
    bedrock_session_provider: Optional[SessionProvider] = None
    # Sesión para la tabla DynamoDB. None → credenciales del entorno (la cuenta de
    # la app, distinta del hub). Separada a propósito del proveedor de Bedrock.
    table_session_provider: Optional[SessionProvider] = None


def _hash_text(text: str) -> str:
    """Huella corta del texto de origen, para detectar cambios (staleness):
    re-embeber solo si el texto cambió respecto al vector guardado."""
    return sha256(text.encode("utf-8")).hexdigest()[:16]


def _to_bytes(raw: Any) -> bytes:
    """Normaliza lo que devuelve DynamoDB para un atributo Binary (boto3 lo envuelve
    en su tipo Binary; según la ruta puede llegar como bytes crudos)."""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    value = getattr(raw, "value", None)
    if value is not None:
        return bytes(value)
    return bytes(raw)


class TitanEmbedder:
    """Adapter de Amazon Titan Text Embeddings V2. Es modelo NATIVO de Amazon (no
    pasa por AWS Marketplace), así que la SCP de la organización que bloquea a
    Claude no lo afecta. Multilingüe; ~$0.02 por millón de tokens."""

    def __init__(self, config: EmbeddingConfig) -> None:
        self._config = config

    def _client(self):
        provider = self._config.bedrock_session_provider
        session = provider() if provider else boto3.Session(region_name=self._config.region)
        return session.client("bedrock-runtime", region_name=self._config.region)

    def embed(self, text: str) -> list[float]:
        body = json.dumps({
            "inputText": text[: self._config.max_input_chars],
            "dimensions": self._config.dimensions,
            "normalize": True,          # vectores unitarios → coseno = producto punto
        })
        resp = self._client().invoke_model(modelId=self._config.model_id, body=body)
        payload = json.loads(resp["body"].read())
        return payload["embedding"]


class DynamoVectorStore:
    """Persistencia de vectores en la tabla única. Respeta la REGLA de paginación
    del proyecto (loop de LastEvaluatedKey) aunque no herede de BaseRepository:
    el módulo es autocontenido a propósito."""

    def __init__(self, config: EmbeddingConfig) -> None:
        self._config = config

    def _table(self):
        provider = self._config.table_session_provider
        session = provider() if provider else boto3.Session(region_name=self._config.region)
        return session.resource("dynamodb", region_name=self._config.region).Table(self._config.table_name)

    def _pk(self, doc_id: str) -> str:
        return f"EMBED#{self._config.namespace}#{doc_id}"

    def _sk(self) -> str:
        return f"EMBED#{self._config.namespace}"

    def get_hash(self, doc_id: str) -> str:
        """Solo la huella del texto (proyección mínima): idempotencia barata."""
        resp = self._table().get_item(
            Key={"PK": self._pk(doc_id), "SK": self._sk()},
            ProjectionExpression="srcHash")
        return (resp.get("Item") or {}).get("srcHash", "")

    def put(self, doc_id: str, vector: list[float], src_hash: str,
            meta: dict[str, Any], updated_at: str) -> None:
        from boto3.dynamodb.types import Binary
        packed = struct.pack(f"<{len(vector)}f", *vector)
        self._table().put_item(Item={
            "PK": self._pk(doc_id),
            "SK": self._sk(),
            self._config.entity_attr: f"EMBEDDING#{self._config.namespace}",
            "docId": doc_id,
            "vec": Binary(packed),
            "dim": len(vector),
            "srcHash": src_hash,
            "meta": meta or {},
            "updatedAt": updated_at,
        })

    def delete(self, doc_id: str) -> None:
        self._table().delete_item(Key={"PK": self._pk(doc_id), "SK": self._sk()})

    def _all_vectors(self) -> list[dict[str, Any]]:
        """Todos los vectores del namespace vía el GSI (query exacta por
        entityType, paginada). No mezcla otros namespaces ni otros items."""
        table = self._table()
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "IndexName": self._config.entity_index,
            "KeyConditionExpression": Key(self._config.entity_attr).eq(
                f"EMBEDDING#{self._config.namespace}"),
        }
        while True:
            resp = table.query(**kwargs)
            items.extend(resp.get("Items", []))
            last = resp.get("LastEvaluatedKey")
            if not last:
                return items
            kwargs["ExclusiveStartKey"] = last

    def nearest(self, query_vec: list[float], top_k: int,
                min_score: float) -> list[dict[str, Any]]:
        q = query_vec
        qn = sum(v * v for v in q) ** 0.5 or 1.0
        scored: list[dict[str, Any]] = []
        for item in self._all_vectors():
            dim = int(item.get("dim", self._config.dimensions))
            try:
                vec = struct.unpack(f"<{dim}f", _to_bytes(item["vec"]))
            except (KeyError, struct.error):
                continue
            if len(vec) != len(q):
                continue
            dot = sum(a * b for a, b in zip(q, vec))
            vn = sum(v * v for v in vec) ** 0.5 or 1.0
            score = dot / (qn * vn)
            if score >= min_score:
                scored.append({"docId": item.get("docId", ""), "score": score,
                               "meta": item.get("meta", {})})
        scored.sort(key=lambda r: r["score"], reverse=True)
        return scored[:top_k]


class EmbeddingIndex:
    """Fachada — lo ÚNICO que tocan los consumidores. Une embedder + store y añade
    idempotencia (no re-embebe si el texto no cambió)."""

    def __init__(self, config: EmbeddingConfig) -> None:
        self._config = config
        self._embedder = TitanEmbedder(config)
        self._store = DynamoVectorStore(config)

    def index(self, doc_id: str, text: str, meta: Optional[dict[str, Any]] = None,
              updated_at: str = "") -> bool:
        """Upsert idempotente. Texto vacío → borra el vector. Devuelve True si
        re-embebió (texto nuevo o cambiado), False si no hizo falta."""
        text = (text or "").strip()
        if not text:
            self._store.delete(doc_id)
            return False
        src_hash = _hash_text(text)
        if self._store.get_hash(doc_id) == src_hash:
            return False
        vector = self._embedder.embed(text)
        self._store.put(doc_id, vector, src_hash, meta or {}, updated_at)
        return True

    def delete(self, doc_id: str) -> None:
        self._store.delete(doc_id)

    def search(self, query_text: str, top_k: Optional[int] = None,
               min_score: float = 0.0) -> list[dict[str, Any]]:
        """Devuelve [{docId, score, meta}] ordenado por cercanía semántica."""
        query_text = (query_text or "").strip()
        if not query_text:
            return []
        qvec = self._embedder.embed(query_text)
        return self._store.nearest(qvec, top_k or self._config.top_k, min_score)
