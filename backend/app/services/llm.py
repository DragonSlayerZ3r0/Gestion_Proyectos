from typing import Any

import boto3

from core.errors import ValidationError

# Modelo elegido tras comparar benchmarks de código entre los disponibles on-demand
# en us-east-1 (Claude queda bloqueado por una SCP de la organización que solo
# permite us-east-1/ca-central-1: los modelos Claude exigen inference profile
# cross-region, que siempre intenta salir a otra región). Permiso otorgado a mano
# en el hub — ver docs/permisos_hub.md sección 1d.
HUB_ROLE_ARN = "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader"
REGION = "us-east-1"
MODEL_ID = "zai.glm-5"
# GLM 5 soporta un contexto de 128K tokens (~500K caracteres) — este tope es una
# salvaguarda de costo/latencia, no un límite real del modelo. Por defecto generoso
# para casos de un solo turno (p. ej. sugerencia sobre un CTAS grande con varias
# CTEs); el chat (multi-turno, costo acumulado por mensaje) pasa uno más bajo.
DEFAULT_MAX_PROMPT_CHARS = 30000


class LlmService:
    def _session(self):
        creds = boto3.client("sts").assume_role(
            RoleArn=HUB_ROLE_ARN, RoleSessionName="gp-llm")["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"], region_name=REGION)

    def converse(self, messages: list[dict[str, str]], system: str = "", max_tokens: int = 800,
                 max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS) -> dict[str, Any]:
        """Llamada directa (sin Bedrock Agent) a un modelo on-demand. Sin estado
        propio: `messages` es el historial completo ([{role: "user"|"assistant",
        text: "..."}]) — quien llama (p. ej. el chat) arma y guarda ese historial,
        este servicio solo lo reenvía. `complete()` es el atajo de un solo turno."""
        if not messages:
            raise ValidationError("La conversación no puede estar vacía.")
        total_chars = sum(len(m.get("text") or "") for m in messages)
        if total_chars > max_prompt_chars:
            raise ValidationError(f"La conversación supera el máximo de {max_prompt_chars} caracteres.")

        client = self._session().client("bedrock-runtime")
        kwargs: dict[str, Any] = {
            "modelId": MODEL_ID,
            "messages": [{"role": m["role"], "content": [{"text": m["text"]}]} for m in messages],
            "inferenceConfig": {"maxTokens": max_tokens, "temperature": 0.3},
        }
        if system:
            kwargs["system"] = [{"text": system}]
        resp = client.converse(**kwargs)
        blocks = resp.get("output", {}).get("message", {}).get("content", [])
        text = "".join(b.get("text", "") for b in blocks)
        return {"text": text, "usage": resp.get("usage", {})}

    def complete(self, prompt: str, system: str = "", max_tokens: int = 800,
                 max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS) -> dict[str, Any]:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValidationError("El prompt no puede estar vacío.")
        return self.converse([{"role": "user", "text": prompt}], system=system, max_tokens=max_tokens,
                              max_prompt_chars=max_prompt_chars)
