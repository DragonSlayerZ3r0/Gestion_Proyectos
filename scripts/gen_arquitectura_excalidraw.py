#!/usr/bin/env python3
"""Genera docs/arquitectura.excalidraw — diagrama de arquitectura Gestion Proyectos."""

import json

elements = []
_id = [0]

def uid():
    _id[0] += 1
    return f"id{_id[0]:04d}"

BASE = {
    "angle": 0, "fillStyle": "solid", "roughness": 0, "opacity": 100,
    "groupIds": [], "frameId": None, "seed": 1, "version": 1,
    "versionNonce": 1, "isDeleted": False, "boundElements": [],
    "updated": 1, "link": None, "locked": False,
}

def rect(x, y, w, h, bg, stroke="#1e1e1e", sw=2, style="solid", rx=True, opacity=100):
    e = {**BASE, "id": uid(), "type": "rectangle",
         "x": x, "y": y, "width": w, "height": h,
         "strokeColor": stroke, "backgroundColor": bg,
         "strokeWidth": sw, "strokeStyle": style, "opacity": opacity,
         "roundness": {"type": 3} if rx else None}
    elements.append(e)
    return e["id"]

def txt(cx, cy, t, size=14, color="#1e293b", align="center", w=None, bold=False):
    tw = w or max(len(line) for line in t.split("\n")) * size * 0.62
    lines = t.count("\n") + 1
    th = lines * size * 1.35
    e = {**BASE, "id": uid(), "type": "text",
         "x": cx - tw / 2, "y": cy - th / 2,
         "width": tw, "height": th,
         "strokeColor": color, "backgroundColor": "transparent",
         "strokeWidth": 1, "strokeStyle": "solid",
         "text": t, "fontSize": size, "fontFamily": 2,
         "textAlign": align, "verticalAlign": "middle",
         "baseline": size, "containerId": None,
         "originalText": t, "lineHeight": 1.35}
    elements.append(e)
    return e["id"]

def arrow(x1, y1, x2, y2, label="", dashed=False, color="#455a64", lsize=11):
    dx, dy = x2 - x1, y2 - y1
    e = {**BASE, "id": uid(), "type": "arrow",
         "x": x1, "y": y1, "width": abs(dx), "height": abs(dy),
         "strokeColor": color, "backgroundColor": "transparent",
         "strokeWidth": 2, "strokeStyle": "dashed" if dashed else "solid",
         "roundness": {"type": 2},
         "points": [[0, 0], [dx, dy]],
         "lastCommittedPoint": None,
         "startBinding": None, "endBinding": None,
         "startArrowhead": None, "endArrowhead": "arrow"}
    elements.append(e)
    if label:
        mx, my = x1 + dx / 2, y1 + dy / 2
        txt(mx, my, label, size=lsize, color=color)

# ── Layer bands ───────────────────────────────────────────────────────────────
LAYERS = [
    (58,  82,  "#dbeafe80", "#93c5fd", "CLIENTE"),
    (150, 120, "#ede9fe80", "#c4b5fd", "CDN & IDENTIDAD"),
    (280, 90,  "#dcfce780", "#86efac", "PRESENTACIÓN"),
    (380, 100, "#fef3c780", "#fcd34d", "API"),
    (490, 145, "#fefce880", "#fde68a", "CÓMPUTO"),
    (645, 110, "#ffe4e680", "#fca5a5", "DATOS OPERATIVOS"),
    (765, 120, "#f3e8ff80", "#d8b4fe", "CATÁLOGO & DATA LAKE"),
]
for y, h, bg, stroke, label in LAYERS:
    rect(0, y, 1200, h, bg, stroke, sw=1, rx=False, opacity=60)
    txt(38, y + h / 2, label, size=9, color="#64748b", w=70)

# ── Título ────────────────────────────────────────────────────────────────────
txt(600, 28, "Arquitectura AWS — Gestión de Proyectos", size=20, color="#1e3a5f", w=700)
txt(600, 50, "BanRural · us-east-1 · Cuenta: 186281981036 · Serverless por capas · Ambiente: dev", size=10, color="#64748b", w=750)

# ── Componentes ───────────────────────────────────────────────────────────────

# Usuario
rect(440, 68, 320, 64, "#bfdbfe", "#3b82f6", sw=2)
txt(600, 100, "Navegador — Usuario Interno BanRural", size=13, color="#1e3a5f", w=310)

# CloudFront
rect(75, 162, 250, 98, "#fde68a", "#d97706", sw=2)
txt(200, 200, "CloudFront\nCDN · HTTPS :443", size=13, color="#78350f", w=235)

# Cognito
rect(875, 162, 250, 98, "#c4b5fd", "#7c3aed", sw=2)
txt(1000, 200, "Cognito User Pool\nJWT · OAuth 2.0 · SRP", size=13, color="#3b0764", w=235)

# S3 + Astro
rect(320, 290, 520, 70, "#86efac", "#15803d", sw=2)
txt(580, 325, "S3 Privado + Astro SPA  ·  gestion-proyectos-dev-frontend-186281981036", size=12, color="#14532d", w=510)

# API Gateway
rect(220, 390, 680, 78, "#fcd34d", "#b45309", sw=2)
txt(560, 416, "API Gateway HTTP API  ·  JWT Authorizer (Cognito)  ·  CORS habilitado", size=13, color="#78350f", w=665)
txt(560, 455, "/api/me · /api/workspace · /api/people · /api/projects(+tasks) · /api/catalog(+sync) · /api/home/summary|costs · /api/admin/users", size=9, color="#92400e", w=665)

# Lambda outer box
rect(160, 500, 870, 130, "#fefce8", "#ca8a04", sw=2)
txt(595, 514, "Lambda  gestion-proyectos-dev-api  ·  Python 3.12  ·  512 MB  ·  timeout 300 s  ·  arquitectura modular (SOLID)", size=12, color="#713f12", w=855)

# Lambda internals — handler delgado → router por registro → módulos → servicios → repos por dominio
for bx, lbl, sub, c, cs in [
    (175,  "handler.py",      "core/router (registro)",   "#fef9c3", "#eab308"),
    (370,  "modules/",        "*_routes autodescubiertos","#fef9c3", "#eab308"),
    (565,  "services/",       "lógica por dominio",       "#fef9c3", "#eab308"),
    (760,  "repositories/",   "1 repo por dominio",       "#fef9c3", "#eab308"),
]:
    rect(bx, 524, 180, 96, c, cs, sw=1)
    txt(bx + 90, 558, f"{lbl}\n{sub}", size=12, color="#713f12", w=170)

# Flechas internas Lambda
arrow(355, 572, 370, 572, color="#ca8a04")
arrow(550, 572, 565, 572, color="#ca8a04")
arrow(745, 572, 760, 572, color="#ca8a04")

# DynamoDB
rect(55, 655, 280, 92, "#fca5a5", "#dc2626", sw=2)
txt(195, 685, "DynamoDB\ngestion-proyectos-dev-main\nPK / SK  ·  PAY_PER_REQUEST  ·  PITR", size=11, color="#7f1d1d", w=268)

# Glue
rect(415, 655, 260, 92, "#f0abfc", "#a21caf", sw=2)
txt(545, 701, "AWS Glue Catalog\nmetadata técnica · BDs · tablas · columnas", size=12, color="#4a044e", w=248)

# Athena
rect(745, 655, 260, 92, "#a78bfa", "#6d28d9", sw=2)
txt(875, 701, "Amazon Athena\npreview controlado · resultados limitados", size=12, color="#2e1065", w=248)

# S3 Data Lake
rect(745, 775, 260, 84, "#6ee7b7", "#059669", sw=2)
txt(875, 817, "S3 Data Lake\ndatos fuente BanRural", size=12, color="#064e3b", w=248)

# CloudWatch
rect(1000, 655, 145, 70, "#bae6fd", "#0284c7", sw=2)
txt(1072, 690, "CloudWatch\nlogs · 1 mes", size=11, color="#0c4a6e", w=133)

# Cost Explorer (módulo Inicio: cuenta app directo + hub vía AssumeRole)
rect(1000, 775, 175, 84, "#fbcfe8", "#be185d", sw=2)
txt(1087, 817, "Cost Explorer\napp 186281981036 directo\nhub 396913696127 (AssumeRole)", size=10, color="#831843", w=163)

# ── Flechas principales ───────────────────────────────────────────────────────

# Usuario → CloudFront
arrow(500, 132, 260, 162, "HTTPS :443")

# Usuario → Cognito
arrow(700, 132, 940, 162, "login / Auth")

# CloudFront → S3
arrow(235, 260, 395, 290, "serve static")

# Cognito → S3
arrow(945, 260, 740, 290, "idToken JWT", color="#7c3aed")

# S3 → API GW
arrow(555, 360, 555, 390, "Bearer JWT · /api/*")

# API GW → Lambda
arrow(555, 468, 555, 500, "event{ path, method, claims }")

# Lambda → DynamoDB
arrow(300, 630, 235, 655, "Query / PutItem / UpdateItem")

# Lambda → Glue (implementado: sync del catálogo)
arrow(545, 630, 545, 655, "GetDatabases/Tables (sync)", color="#a21caf")

# Lambda → Athena (dashed)
arrow(800, 630, 845, 655, "StartQuery (planeado)", dashed=True, color="#6d28d9")

# Lambda → Cost Explorer
arrow(1010, 630, 1070, 775, "GetCostAndUsage", color="#be185d", lsize=9)

# Lambda → S3 Data Lake (stats S3 del catálogo + monitoreo de cargas por día)
arrow(690, 630, 770, 775, "ListBucket (stats catálogo +\nmonitoreo de cargas)", color="#059669", lsize=9)

# Auto-invocación asíncrona (sync del catálogo + escaneo de cargas del data lake)
arrow(1115, 545, 1032, 545, "↺ auto-invoca async\ncatalog_sync_all / datalake_ingest_scan", dashed=True, color="#ca8a04", lsize=9)

# ── Límite cross-account: recursos en la cuenta hub 396913696127 ───────────────
rect(728, 760, 460, 122, "transparent", "#be185d", sw=2, style="dashed", rx=True)
txt(905, 873, "Cuenta hub 396913696127 · acceso cross-account (bucket policy S3 / AssumeRole Cost Explorer)", size=9, color="#be185d", w=450)

# Athena → S3 DataLake
arrow(875, 747, 875, 775, "s3://datalake/*", color="#059669")

# Lambda → CloudWatch (dashed)
arrow(1030, 630, 1055, 655, "logs", dashed=True, color="#0284c7")

# ── Leyenda ───────────────────────────────────────────────────────────────────
rect(60, 898, 1080, 38, "#f1f5f9", "#cbd5e1", sw=1, rx=True)
arrow(80, 917, 130, 917, color="#455a64")
txt(195, 917, "Flujo principal", size=10, color="#334155", w=100)
arrow(310, 917, 360, 917, dashed=True, color="#7c3aed")
txt(470, 917, "Integración planeada (Athena / Lake Formation)", size=10, color="#334155", w=270)
txt(800, 917, "Frontend: https://d269paz1z7q1g0.cloudfront.net  ·  API: https://63ibnl13da.execute-api.us-east-1.amazonaws.com", size=9, color="#94a3b8", w=590)

# ── Output ────────────────────────────────────────────────────────────────────
doc = {
    "type": "excalidraw",
    "version": 2,
    "source": "https://excalidraw.com",
    "elements": elements,
    "appState": {
        "gridSize": None,
        "viewBackgroundColor": "#ffffff"
    },
    "files": {}
}

out_path = "docs/arquitectura.excalidraw"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)

print(f"✓ Excalidraw generado: {out_path}  ({len(elements)} elementos)")
