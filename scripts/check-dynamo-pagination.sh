#!/usr/bin/env bash
# Guardrail: prohíbe query/scan de DynamoDB SIN paginar fuera de la clase base.
#
# Por qué existe: DynamoDB devuelve máx. 1 MB por página (en scan, ANTES de
# aplicar el filtro). Una lectura de una sola página "funciona" mientras la
# tabla es chica y un día devuelve datos incompletos SIN error — así se "vació"
# el módulo Proyectos cuando los items ATHENA#EXEC del monitoreo llenaron las
# primeras páginas del scan (2026-07-03), con los datos intactos en la tabla.
#
# Regla: los repos usan SIEMPRE self._query_all(...) / self._scan_all(...)
# (BaseRepository, ya paginados). Este check corre en `npm run check` y falla
# si aparece un query( o scan( directo sobre self._table fuera de base.py.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIOLATIONS="$(grep -rn "_table\.query(\|_table\.scan(" "$ROOT/backend/app" \
  --include="*.py" | grep -v "repositories/base.py" || true)"

if [[ -n "$VIOLATIONS" ]]; then
  echo "✗ Query/scan de DynamoDB sin paginar (usa self._query_all / self._scan_all de BaseRepository):" >&2
  echo "$VIOLATIONS" >&2
  exit 1
fi
echo "✓ Paginación DynamoDB: OK (sin query/scan crudos fuera de base.py)"
