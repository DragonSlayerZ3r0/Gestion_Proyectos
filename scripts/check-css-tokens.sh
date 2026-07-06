#!/usr/bin/env bash
# Guardrail: prohíbe hardcodear un color hex que YA es un token de diseño.
#
# Por qué existe: app.css tiene tokens en :root (--accent, --panel, --danger…),
# pero durante el crecimiento orgánico se colaron cientos de hex repetidos que
# duplicaban esos tokens (#0f766e = --accent 16×, #ffffff = --panel 39×…), lo que
# rompe la "única fuente de verdad" del color y hace imposible, p. ej., un modo
# oscuro. Tras tokenizar (2026-07-06), este check evita que la deuda vuelva.
#
# Regla: si un valor hex que coincide EXACTO con el de un token aparece fuera de
# :root, usa var(--ese-token). No marca colores de un solo uso (esos pueden ser
# hex literales); solo los que ya tienen token. Corre en `npm run check`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSS="$ROOT/frontend/src/styles"

fail=0
for f in "$CSS"/*.css; do
  [[ -e "$f" ]] || continue
  # Mapa token -> hex, leído del propio :root (líneas '--nombre: #hex;').
  while IFS= read -r def; do
    name="$(printf '%s' "$def" | sed -E 's/^[[:space:]]*(--[a-z-]+):.*/\1/')"
    hex="$(printf '%s' "$def" | grep -oiE '#[0-9a-f]{3,6}' | head -1)"
    [[ -n "$name" && -n "$hex" ]] || continue
    # Buscar el hex fuera de las líneas de definición de token (que empiezan con --).
    hits="$(grep -niE "$hex\b" "$f" | grep -vE '^\s*[0-9]+:\s*--' || true)"
    if [[ -n "$hits" ]]; then
      echo "✗ $(basename "$f"): '$hex' está tokenizado como $name — usa var($name):" >&2
      echo "$hits" | sed 's/^/    /' >&2
      fail=1
    fi
  done < <(grep -hE '^\s*--[a-z-]+:\s*#[0-9a-fA-F]{3,6}' "$CSS"/*.css)
done

if [[ "$fail" -ne 0 ]]; then
  echo "" >&2
  echo "Reemplaza cada hex por su token var(--…). Los tokens viven en el :root de app.css." >&2
  exit 1
fi
echo "✓ CSS: sin hex hardcodeados que dupliquen un token."
