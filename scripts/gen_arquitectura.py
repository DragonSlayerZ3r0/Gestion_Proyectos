#!/usr/bin/env python3
"""Genera docs/arquitectura.svg — diagrama de arquitectura Gestion Proyectos."""

W, H = 980, 860
out = []

def a(*args):
    out.extend(args)

a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Segoe UI, Arial, sans-serif">')

a('''<defs>
  <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#455A64"/>
  </marker>
  <marker id="arr-dash" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#7C3AED"/>
  </marker>
  <marker id="arr-green" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="#059669"/>
  </marker>
  <filter id="sh" x="-8%" y="-8%" width="116%" height="120%">
    <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#00000018"/>
  </filter>
</defs>''')

# Fondo
a(f'<rect width="{W}" height="{H}" fill="#F8FAFC"/>')

# ── Bandas de capas ───────────────────────────────────────────────────────────
layers = [
    (64,  76,  "#DBEAFE", "Cliente"),
    (150, 108, "#EDE9FE", "CDN & Identidad"),
    (268, 88,  "#DCFCE7", "Presentación"),
    (366, 92,  "#FEF3C7", "API"),
    (468, 128, "#FEFCE8", "Cómputo"),
    (606, 112, "#FFE4E6", "Datos Operativos"),
    (728, 102, "#F3E8FF", "Catálogo & Data Lake"),
]
for y, h, color, label in layers:
    a(f'<rect x="0" y="{y}" width="{W}" height="{h}" fill="{color}" opacity="0.55"/>')
    a(f'<line x1="0" y1="{y}" x2="{W}" y2="{y}" stroke="#CBD5E1" stroke-width="0.8"/>')
    a(f'<text x="7" y="{y + h//2 + 4}" font-size="9" fill="#64748B" font-weight="700">{label}</text>')

# ── Título ────────────────────────────────────────────────────────────────────
a('<text x="490" y="30" font-size="17" font-weight="700" fill="#1E3A5F" text-anchor="middle">Arquitectura AWS — Gestión de Proyectos</text>')
a('<text x="490" y="48" font-size="10.5" fill="#64748B" text-anchor="middle">BanRural · Region: us-east-1 · Cuenta: 186281981036 · Serverless por capas · Ambiente: dev</text>')

# ── Helpers ───────────────────────────────────────────────────────────────────
def box(x, y, w, h, fill, stroke, label, sub="", rx=10):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" filter="url(#sh)"/>')
    if sub:
        a(f'<text x="{x+w//2}" y="{y+h//2-4}" font-size="12" font-weight="600" fill="#1E293B" text-anchor="middle">{label}</text>')
        a(f'<text x="{x+w//2}" y="{y+h//2+12}" font-size="9.5" fill="#475569" text-anchor="middle">{sub}</text>')
    else:
        a(f'<text x="{x+w//2}" y="{y+h//2+5}" font-size="12" font-weight="600" fill="#1E293B" text-anchor="middle">{label}</text>')

def tag(x, y, text, color="#64748B", bg="#F1F5F9"):
    tw = len(text) * 6 + 10
    a(f'<rect x="{x-tw//2}" y="{y-11}" width="{tw}" height="15" rx="4" fill="{bg}"/>')
    a(f'<text x="{x}" y="{y+1}" font-size="9" fill="{color}" text-anchor="middle" font-weight="600">{text}</text>')

def arr(x1, y1, x2, y2, label="", dashed=False, color="#455A64", mk="arr"):
    dash = ' stroke-dasharray="6,4"' if dashed else ''
    a(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.5"{dash} marker-end="url(#{mk})"/>')
    if label:
        mx, my = (x1+x2)//2, (y1+y2)//2
        tw = len(label)*6+8
        a(f'<rect x="{mx-tw//2}" y="{my-11}" width="{tw}" height="14" rx="3" fill="white" opacity="0.88"/>')
        a(f'<text x="{mx}" y="{my+1}" font-size="9.5" fill="{color}" text-anchor="middle" font-weight="500">{label}</text>')

# ── Componentes ───────────────────────────────────────────────────────────────

# Usuario
box(360, 74, 260, 56, "#BFDBFE", "#3B82F6", "Navegador — Usuario Interno BanRural")

# CloudFront
box(85, 162, 210, 82, "#FDE68A", "#D97706", "CloudFront", "CDN · HTTPS :443 · cache optimizado")

# Cognito
box(665, 162, 220, 82, "#C4B5FD", "#7C3AED", "Cognito User Pool", "JWT · OAuth 2.0 · SRP · USER_PASSWORD_AUTH")

# S3 + Astro SPA
box(290, 278, 400, 68, "#86EFAC", "#15803D", "S3 Privado + Astro SPA", "gestion-proyectos-dev-frontend-186281981036")

# API Gateway
box(220, 378, 540, 70, "#FCD34D", "#B45309", "API Gateway HTTP API", "JWT Authorizer (Cognito) · CORS habilitado")

# Endpoints en API GW
a('<text x="490" y="460" font-size="8.5" fill="#78350F" text-anchor="middle">')
a('GET /health · GET /api/me · GET /api/workspace · POST|PATCH /api/people · POST|PATCH|DELETE /api/projects · POST|PATCH /api/projects/{id}/tasks')
a('</text>')

# Lambda (caja grande)
box(155, 478, 660, 116, "#FEFCE8", "#CA8A04", "", rx=10)
a('<text x="485" y="498" font-size="12" font-weight="700" fill="#1E293B" text-anchor="middle">Lambda  gestion-proyectos-dev-api  ·  Python 3.12  ·  256 MB  ·  timeout 10 s</text>')
# Internos Lambda
for i, (bx, lbl, sub) in enumerate([
    (175, "handler.py", "router HTTP"),
    (355, "services/", "workspace · users"),
    (535, "repositories/", "dynamodb.py"),
    (700, "auth.py", "JWT claims"),
]):
    box(bx, 508, 160, 72, "#FEF9C3", "#EAB308", lbl, sub, rx=7)
    if i < 3:
        arr(bx+160, 544, bx+160+15, 544)  # flechita interna entre cajas

# DynamoDB
box(50, 618, 230, 96, "#FCA5A5", "#DC2626", "DynamoDB", "gestion-proyectos-dev-main · PAY_PER_REQUEST · PITR", rx=10)
a('<text x="165" y="692" font-size="8" fill="#991B1B" text-anchor="middle">PK: USER# · PERSON# · PROJECT# · AUDIT# · SETTING#</text>')
a('<text x="165" y="703" font-size="8" fill="#991B1B" text-anchor="middle">SK: PROFILE · MODULE# · META · TASK# · PERSON#</text>')

# Glue Catalog (multi-cuenta: app directo + hub vía AssumeRole)
box(360, 618, 215, 96, "#F0ABFC", "#A21CAF", "AWS Glue Catalog", "multi-cuenta · app directo · hub AssumeRole+LF", rx=10)

# Athena
box(650, 618, 215, 96, "#A78BFA", "#6D28D9", "Amazon Athena", "preview controlado · resultados limitados", rx=10)

# S3 Data Lake
box(650, 740, 215, 78, "#6EE7B7", "#059669", "S3 Data Lake", "datos fuente BanRural", rx=10)

# CloudWatch (pequeño, derecho)
box(880, 618, 85, 58, "#BAE6FD", "#0284C7", "CloudWatch", "logs 1 mes", rx=8)

# ── Flechas ───────────────────────────────────────────────────────────────────

# Usuario → CloudFront
arr(420, 130, 230, 162, "HTTPS :443")

# Usuario → Cognito
arr(560, 130, 730, 162, "login")

# CloudFront → S3
arr(225, 244, 375, 278, "serve static")

# Cognito → S3 (JWT)
arr(730, 244, 610, 278, "idToken JWT", color="#7C3AED")

# S3 → API GW
arr(490, 346, 490, 378, "Bearer JWT · /api/*")

# API GW → Lambda
arr(490, 448, 490, 478, "event{ path, method, claims }")

# Lambda → DynamoDB
arr(270, 594, 200, 618, "Query / PutItem / UpdateItem")

# Lambda → Glue (dashed)
arr(467, 594, 467, 618, "GetTable / GetDatabase", dashed=True, color="#A21CAF", mk="arr-dash")

# Lambda → Athena (dashed)
arr(690, 594, 720, 618, "StartQueryExecution", dashed=True, color="#6D28D9", mk="arr-dash")

# Athena → S3 DataLake
arr(757, 714, 757, 740, "s3://datalake/*", dashed=True, color="#059669", mk="arr-green")

# Lambda → CloudWatch
arr(815, 536, 880, 618, "logs", dashed=True, color="#0284C7")

# ── Leyenda ───────────────────────────────────────────────────────────────────
a(f'<rect x="20" y="836" width="{W-40}" height="17" rx="4" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1"/>')
a('<line x1="36" y1="844" x2="68" y2="844" stroke="#455A64" stroke-width="1.5" marker-end="url(#arr)"/>')
a('<text x="74" y="848" font-size="9" fill="#334155">Flujo principal</text>')
a('<line x1="175" y1="844" x2="207" y2="844" stroke="#7C3AED" stroke-width="1.5" stroke-dasharray="6,4" marker-end="url(#arr-dash)"/>')
a('<text x="213" y="848" font-size="9" fill="#334155">Integración catálogo (planeada/controlada)</text>')
a('<text x="510" y="848" font-size="9" fill="#94A3B8">Frontend URL: https://d269paz1z7q1g0.cloudfront.net  ·  API URL: https://63ibnl13da.execute-api.us-east-1.amazonaws.com</text>')

a('</svg>')

out_path = "docs/arquitectura.svg"
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(out))

print(f"✓ SVG generado: {out_path}")
