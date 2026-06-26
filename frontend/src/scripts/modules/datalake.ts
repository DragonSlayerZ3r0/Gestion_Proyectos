// @ts-nocheck
// Monitoreo de cargas del data lake (pestaña Data Lake del módulo Inicio).
// Sub-módulo con inyección de dependencias: el módulo Inicio lo compone y delega
// el render/eventos/gráfico de esta sección, igual que el shell delega en módulos.
export function createDatalakeModule(ctx) {
  const {
    state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes,
    catalogSyncedLabel, homeDateTimeLabel, chartColors, repaint,
  } = ctx;

  // Orden de la tabla de cargas por día (compartido entre áreas). Por defecto
  // fecha descendente (la última primero).
  let daySortKey = "date";   // "date" | "count" | "bytes"
  let daySortDir = "desc";   // "asc" | "desc"
  // Orden de la tabla de tablas (vista Registros · Por área). Por defecto registros desc.
  let tableSortKey = "rows"; // "name" | "files" | "bytes" | "rows"
  let tableSortDir = "desc"; // "asc" | "desc"

  function zoneLabel(zn) {
    return zn ? zn.charAt(0).toUpperCase() + zn.slice(1) : "";
  }

  // ── Rango de fechas (filtro de visualización, sin re-escanear) ──────────────
  function isoMinusDays(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function rangeBounds() {
    const p = state.ingestRangePreset;
    if (p === "all") return { from: null, to: null };
    if (p === "30d") return { from: isoMinusDays(30), to: null };
    if (p === "90d") return { from: isoMinusDays(90), to: null };
    if (p === "year") return { from: `${new Date().getUTCFullYear()}-01-01`, to: null };
    return { from: state.ingestRangeFrom || null, to: state.ingestRangeTo || null };
  }
  function inRange(day, b) {
    return (!b.from || day >= b.from) && (!b.to || day <= b.to);
  }
  function rangeTotals(byDay, b) {
    let count = 0, bytes = 0;
    for (const d of Object.keys(byDay || {})) {
      if (inRange(d, b)) { count += Number(byDay[d].count) || 0; bytes += Number(byDay[d].bytes) || 0; }
    }
    return { count, bytes };
  }
  // Totales por área dentro del rango: del overview si es "Todo", o del detalle
  // (byArea→byDay) sumando los días del rango. Devuelve null si falta el detalle.
  function areaTotalsForRange(zone, z, b) {
    if (b.from === null && b.to === null) return z.areas || [];
    const detail = state.ingestDetail[zone];
    if (!detail) return null;
    const totals = [];
    for (const area of Object.keys(detail)) {
      let count = 0, bytes = 0;
      for (const d of Object.keys(detail[area])) {
        if (inRange(d, b)) { count += Number(detail[area][d].count) || 0; bytes += Number(detail[area][d].bytes) || 0; }
      }
      if (count > 0 || bytes > 0) totals.push({ area, count, bytes });
    }
    totals.sort((x, y) => y.bytes - x.bytes);
    return totals;
  }
  function rangeControl() {
    const p = state.ingestRangePreset;
    // "Todo" (sin límites) no aplica a Registros: el conteo se calcula vía Athena y
    // exige un rango acotado. Para Archivos/Peso sí se ofrece (histórico completo).
    const presets = [["all", "Todo"], ["30d", "30 días"], ["90d", "90 días"], ["year", "Este año"]]
      .filter(([k]) => !(state.ingestMetric === "records" && k === "all"));
    const btns = presets.map(([k, l]) => `<button type="button" class="homeViewBtn ${p === k ? "active" : ""}" data-ingest-range="${k}">${l}</button>`).join("");
    return `
      <div class="ingestControls">
        <div class="homeViewToggle" role="group" aria-label="Rango">${btns}</div>
        <label class="ingestDateLbl">Desde <input type="date" id="ingestFrom" value="${escapeAttribute(state.ingestRangeFrom || "")}" /></label>
        <label class="ingestDateLbl">Hasta <input type="date" id="ingestTo" value="${escapeAttribute(state.ingestRangeTo || "")}" /></label>
      </div>`;
  }

  function applyIngestPayload(d) {
    state.ingestData = d.data || null;
    state.ingestScannedAt = d.scannedAt || null;
    state.ingestStatus = d.status || "empty";
    state.ingestScanning = !!d.scanning;
    const zones = state.ingestData && state.ingestData.zones ? Object.keys(state.ingestData.zones) : [];
    if (!state.ingestZone || !zones.includes(state.ingestZone)) state.ingestZone = zones[0] || null;
  }

  // Carga (o re-chequea) el overview. El backend dispara un escaneo en segundo
  // plano si el histograma está vencido; aquí solo leemos y poleamos.
  async function ensureIngest() {
    if (state.ingestLoading || state.ingestScanning) return;
    await loadIngest();
  }

  async function loadIngest() {
    state.ingestLoading = true;
    state.ingestError = "";
    repaint();
    try {
      const payload = await apiRequest(`api/datalake/ingest?bucket=${encodeURIComponent(state.ingestBucket)}`);
      applyIngestPayload(payload.data);
    } catch (err) {
      state.ingestError = err?.message || "No se pudo cargar el monitoreo de cargas.";
    }
    state.ingestLoading = false;
    repaint();
    if (state.ingestScanning) scheduleIngestPoll();
    else ensureDetailForRange(); // rango por defecto (90d) necesita totales por área
  }

  async function scanIngest() {
    if (state.ingestScanning) return;
    try {
      await apiRequest(`api/datalake/ingest/scan?bucket=${encodeURIComponent(state.ingestBucket)}`, { method: "POST" });
      state.ingestScanning = true;
    } catch (err) {
      window.alert(err?.message || "No se pudo iniciar el escaneo.");
      return;
    }
    repaint();
    scheduleIngestPoll();
  }

  // Poll mientras hay un escaneo en curso (el listado de S3 corre async).
  function scheduleIngestPoll() {
    if (state.ingestPollTimer) return;
    state.ingestPollTimer = window.setTimeout(async () => {
      state.ingestPollTimer = null;
      try {
        const payload = await apiRequest(`api/datalake/ingest?bucket=${encodeURIComponent(state.ingestBucket)}`);
        applyIngestPayload(payload.data);
      } catch {}
      repaint();
      if (state.ingestScanning) scheduleIngestPoll();
    }, 4000);
  }

  async function loadIngestDetail(zone) {
    if (state.ingestDetail[zone]) return;
    state.ingestDetailLoadingZone = zone;
    repaint();
    try {
      const payload = await apiRequest(`api/datalake/ingest/detail?bucket=${encodeURIComponent(state.ingestBucket)}&zone=${encodeURIComponent(zone)}`);
      state.ingestDetail[zone] = payload.data.byArea || {};
    } catch {
      state.ingestDetail[zone] = {};
    }
    state.ingestDetailLoadingZone = null;
    repaint();
  }

  function toggleIngestArea(area) {
    if (state.ingestOpenArea === area) { state.ingestOpenArea = null; repaint(); return; }
    state.ingestOpenArea = area;
    repaint();
    if (!state.ingestDetail[state.ingestZone]) loadIngestDetail(state.ingestZone);
  }

  function ingestSection() {
    const bucket = state.ingestBucket;
    const zones = state.ingestData && state.ingestData.zones ? Object.keys(state.ingestData.zones) : [];
    const zone = state.ingestZone;
    const z = zone && state.ingestData ? state.ingestData.zones[zone] : null;
    const metric = state.ingestMetric;

    const fresh = state.ingestScannedAt
      ? `Escaneado: <b>${homeDateTimeLabel(state.ingestScannedAt)}</b> <span class="homeCostAgo">(${catalogSyncedLabel(state.ingestScannedAt)})</span>`
      : "Aún no escaneado";
    const scanningMsg = state.ingestScanning ? ` · <span class="ingestScanning">Escaneando…</span>` : "";

    let inner;
    if (state.ingestError) {
      inner = `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.ingestError)}</p>`;
    } else if (!state.ingestData && state.ingestScanning) {
      inner = `<p class="catalogEmpty">Escaneando por primera vez… esto puede tardar un momento (se actualiza solo).</p>`;
    } else if (!state.ingestData && state.ingestLoading) {
      inner = `<p class="catalogEmpty">Cargando…</p>`;
    } else if (!state.ingestData) {
      inner = `<p class="catalogEmpty">Sin datos todavía. Presiona "Escanear ahora".</p>`;
    } else {
      const records = metric === "records";
      const zoneTabs = zones.map((zn) => `<button type="button" class="homeViewBtn ${zn === zone ? "active" : ""}" data-ingest-zone="${escapeAttribute(zn)}">${escapeHtml(zoneLabel(zn))}</button>`).join("");
      const metricTabs = `
        <button type="button" class="homeViewBtn ${metric === "count" ? "active" : ""}" data-ingest-metric="count">Archivos</button>
        <button type="button" class="homeViewBtn ${metric === "bytes" ? "active" : ""}" data-ingest-metric="bytes">Peso</button>
        <button type="button" class="homeViewBtn ${records ? "active" : ""}" data-ingest-metric="records" title="Filas ingestadas por tabla, de la bitácora de ingesta (del rango).">Registros</button>`;
      const b = rangeBounds();
      const rr = recordsRange();
      const rec = records ? currentRecords() : null;
      let totals;
      if (records) {
        if (!rr) totals = `<span class="homeCostAgo">selecciona un rango (no "Todo")</span>`;
        else if (!rec || rec.loading || !rec.data) totals = `<span class="homeCostAgo">calculando registros…</span>`;
        else { const t = recordsTotals(rec); totals = `${t.rows.toLocaleString("en-US")} registros · ${t.files.toLocaleString("en-US")} archivos <span class="homeCostAgo">(por fecha de ingesta · reporte oficial)</span>`; }
      } else {
        const rt = z ? rangeTotals(z.byDay, b) : { count: 0, bytes: 0 };
        const rangeNote = (b.from === null && b.to === null) ? "todo el histórico" : "en el rango";
        totals = `${rt.count.toLocaleString("en-US")} archivos · ${formatBytes(rt.bytes)} <span class="homeCostAgo">(${rangeNote})</span>`;
      }
      const byArea = state.ingestGroupBy !== "date";
      const groupTabs = `
        <button type="button" class="homeViewBtn ${byArea ? "active" : ""}" data-ingest-groupby="area">Por área</button>
        <button type="button" class="homeViewBtn ${!byArea ? "active" : ""}" data-ingest-groupby="date">Por fecha</button>`;
      const chartTitleMetric = records ? "registros" : (metric === "count" ? "archivos" : "peso");
      let view;
      if (records) {
        if (!rr) view = `<div class="homeTopList"><p class="catalogEmpty">Selecciona un rango de fechas (distinto de "Todo") para contar registros.</p></div>`;
        else if (rec && rec.error) view = `<div class="homeTopList"><p class="catalogEmpty catalogEmptyError">${escapeHtml(rec.error)}</p></div>`;
        else if (!rec || rec.loading || (rec.scanning && !rec.data)) view = `<div class="homeTopList"><p class="catalogEmpty">Calculando registros del rango… (se actualiza solo)</p></div>`;
        else view = byArea ? recordsAreaList(rec) : recordsDayList(rec);
      } else {
        view = byArea ? ingestAreaList(z, b) : ingestDayList(z, b);
      }
      inner = `
        <div class="ingestControls">
          <div class="homeViewToggle" role="group" aria-label="Zona">${zoneTabs}</div>
          <div class="homeViewToggle" role="group" aria-label="Métrica">${metricTabs}</div>
          <span class="homeTopMeta">${totals}</span>
        </div>
        ${rangeControl()}
        <div class="homeChartBox"><h3>Cargas por día · ${chartTitleMetric} (${escapeHtml(zoneLabel(zone))})</h3><canvas id="ingestChart"></canvas></div>
        <div class="ingestControls"><div class="homeViewToggle" role="group" aria-label="Agrupar por">${groupTabs}</div></div>
        ${view}`;
    }

    return `
      <article class="panel homePanel">
        <div class="homeCostHeader">
          <div><p class="eyebrow">Data Lake · ${escapeHtml(bucket)}</p><h2>Monitoreo de cargas</h2>
          <p class="homeDailyFreshness">${fresh}${scanningMsg}</p></div>
          <button type="button" id="ingestScanBtn" class="tinyButton" ${state.ingestScanning ? "disabled" : ""} title="Vuelve a listar S3 y recalcula el histograma por día (puede tardar).">${state.ingestScanning ? "Escaneando…" : "Escanear ahora"}</button>
        </div>
        ${inner}
      </article>`;
  }

  function ingestAreaList(z, b) {
    if (!z) return "";
    const zone = state.ingestZone;
    const areas = areaTotalsForRange(zone, z, b);
    if (areas === null) return `<div class="homeTopList"><h3>Por área (${escapeHtml(zoneLabel(zone))})</h3><p class="catalogEmpty">Cargando totales por área…</p></div>`;
    if (!areas.length) return `<div class="homeTopList"><h3>Por área (${escapeHtml(zoneLabel(zone))})</h3><p class="catalogEmpty">Sin cargas en el rango.</p></div>`;
    const rows = areas.map((a) => {
      const open = state.ingestOpenArea === a.area;
      return `
        <div class="homeSvcRow">
          <div class="homeSvcMain">
            <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-ingest-area="${escapeAttribute(a.area)}" title="Ver cargas por día de ${escapeAttribute(a.area)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>
            <span class="homeSvcName">${escapeHtml(a.area)}</span>
            <span class="homeTopMeta homeSvcAmount">${Number(a.count).toLocaleString("en-US")} arch · ${formatBytes(a.bytes)}</span>
          </div>
          ${open ? `<div class="homeSvcDetail">${ingestAreaDaily(zone, a.area, b)}</div>` : ""}
        </div>`;
    }).join("");
    return `<div class="homeTopList"><h3>Por área (${escapeHtml(zoneLabel(zone))})</h3>${rows}</div>`;
  }

  // Vista "Por fecha": el inverso de "Por área". Lista los días (con sus totales)
  // y al expandir uno muestra qué áreas se ingestaron ESE día — para investigar
  // un pico. Reusa el mismo orden de columnas (daySort).
  function ingestDayList(z, b) {
    if (!z || !z.byDay || !Object.keys(z.byDay).length) return "";
    const zone = state.ingestZone;
    const entries = Object.keys(z.byDay)
      .filter((d) => inRange(d, b))
      .map((d) => ({ day: d, count: Number(z.byDay[d].count) || 0, bytes: Number(z.byDay[d].bytes) || 0 }));
    entries.sort((x, y) => {
      const cmp = daySortKey === "date"
        ? (x.day < y.day ? -1 : x.day > y.day ? 1 : 0)
        : x[daySortKey] - y[daySortKey];
      return daySortDir === "asc" ? cmp : -cmp;
    });
    const rows = entries.map((e) => {
      const open = state.ingestOpenDay === e.day;
      return `
        <tr class="homeDayTr" data-ingest-day="${escapeAttribute(e.day)}">
          <td class="homeDayCellDate"><span class="homeDayToggle ${open ? "open" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></span>${escapeHtml(e.day)}</td>
          <td class="homeDayCellNum">${e.count.toLocaleString("en-US")}</td>
          <td class="homeDayCellNum">${formatBytes(e.bytes)}</td>
        </tr>
        ${open ? `<tr class="homeDayDetailTr"><td colspan="3">${ingestDayAreas(zone, e.day)}</td></tr>` : ""}`;
    }).join("");
    const inner = entries.length
      ? `<table class="homeDailyTable">
          <thead><tr>${daySortHeader("date", "Día", false)}${daySortHeader("count", "Archivos", true)}${daySortHeader("bytes", "Peso", true)}</tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : `<p class="catalogEmpty">Sin cargas en el rango.</p>`;
    return `
      <div class="homeTopList">
        <h3>Por fecha (${escapeHtml(zoneLabel(zone))})</h3>
        ${inner}
      </div>`;
  }

  // Áreas ingestadas en un día concreto (pivote del detalle byArea → ese día).
  function ingestDayAreas(zone, day) {
    const detail = state.ingestDetail[zone];
    if (!detail) return `<p class="catalogEmpty">Cargando…</p>`;
    const areas = Object.keys(detail)
      .map((area) => {
        const v = detail[area][day];
        return v ? { area, count: Number(v.count) || 0, bytes: Number(v.bytes) || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.bytes - a.bytes);
    if (!areas.length) return `<p class="catalogEmpty">Sin cargas registradas ese día.</p>`;
    return `
      <table class="homeSvcTable">
        <thead><tr><th>Área</th><th class="num">Archivos</th><th class="num">Peso</th></tr></thead>
        <tbody>
          ${areas.map((a) => `<tr>
            <td>${escapeHtml(a.area)}</td>
            <td class="homeSvcQty">${a.count.toLocaleString("en-US")}</td>
            <td class="homeSvcAmt">${formatBytes(a.bytes)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function toggleIngestDay(day) {
    state.ingestOpenDayArea = null; // al cambiar de día, cierra el área expandida
    if (state.ingestOpenDay === day) { state.ingestOpenDay = null; repaint(); return; }
    state.ingestOpenDay = day;
    repaint();
    // En modo Registros el desglose por área ya está en memoria (rec.data); el
    // detalle del histograma solo hace falta para las métricas Archivos/Peso.
    if (state.ingestMetric !== "records" && !state.ingestDetail[state.ingestZone]) loadIngestDetail(state.ingestZone);
  }

  function daySortHeader(key, label, numeric) {
    const active = daySortKey === key;
    const arrow = active ? (daySortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="${numeric ? "homeDayCellNum " : ""}sortableTh${active ? " active" : ""}" data-ingest-daysort="${key}">${label}${arrow}</th>`;
  }

  function ingestAreaDaily(zone, area, b) {
    const detail = state.ingestDetail[zone];
    if (!detail) return `<p class="catalogEmpty">Cargando…</p>`;
    const byDay = detail[area];
    if (!byDay || !Object.keys(byDay).length) return `<p class="catalogEmpty">Sin cargas registradas para esta área.</p>`;
    const entries = Object.keys(byDay)
      .filter((d) => !b || inRange(d, b))
      .map((d) => ({ day: d, count: Number(byDay[d].count) || 0, bytes: Number(byDay[d].bytes) || 0 }));
    if (!entries.length) return `<p class="catalogEmpty">Sin cargas en el rango para esta área.</p>`;
    entries.sort((x, y) => {
      const cmp = daySortKey === "date"
        ? (x.day < y.day ? -1 : x.day > y.day ? 1 : 0)
        : x[daySortKey] - y[daySortKey];
      return daySortDir === "asc" ? cmp : -cmp;
    });
    return `
      <table class="homeSvcTable">
        <thead><tr>${daySortHeader("date", "Día", false)}${daySortHeader("count", "Archivos", true)}${daySortHeader("bytes", "Peso", true)}</tr></thead>
        <tbody>
          ${entries.map((e) => `<tr>
            <td>${escapeHtml(e.day)}</td>
            <td class="homeDayCellNum">${e.count.toLocaleString("en-US")}</td>
            <td class="homeDayCellNum">${formatBytes(e.bytes)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  // ── Registros (conteo de filas por área/tabla, acotado al rango) ─────────────
  // El conteo se calcula en backend desde la tabla de control de ingesta (Athena).
  // Requiere un rango con límites (no "Todo"); resolvemos "hasta" → hoy. El
  // resultado se cachea por (zona|inicio|fin) en backend y aquí en memoria.
  function recordsRange() {
    const b = rangeBounds();
    if (b.from === null) return null; // "Todo": sin límite inferior, no aplica
    return { from: b.from, to: b.to || isoMinusDays(0) };
  }
  function recordsKey() {
    const r = recordsRange();
    return r ? `${state.ingestZone}|${r.from}|${r.to}` : null;
  }
  function currentRecords() {
    const k = recordsKey();
    return k ? state.ingestRecords[k] : null;
  }
  function recordsTotals(rec) {
    const byArea = (rec.data && rec.data.byArea) || {};
    let rows = 0, files = 0;
    for (const a of Object.keys(byArea)) {
      rows += Number(byArea[a].rows) || 0;
      files += Number(byArea[a].files) || 0;
    }
    return { rows, files };
  }
  async function ensureRecords() {
    const r = recordsRange();
    if (!r || !state.ingestZone) return;
    const key = recordsKey();
    const cur = state.ingestRecords[key];
    if (cur && (cur.loading || cur.scanning || cur.data || cur.error)) {
      if (cur.scanning) scheduleRecordsPoll(key);
      return;
    }
    await loadRecords(key, r);
  }
  async function fetchRecords(key, r) {
    const payload = await apiRequest(
      `api/datalake/ingest/records?bucket=${encodeURIComponent(state.ingestBucket)}`
      + `&zone=${encodeURIComponent(state.ingestZone)}&start=${r.from}&end=${r.to}`);
    state.ingestRecords[key] = {
      data: payload.data.data || null,
      scanning: !!payload.data.scanning,
      scannedAt: payload.data.scannedAt || null,
      error: "",
    };
  }
  async function loadRecords(key, r) {
    state.ingestRecords[key] = { ...(state.ingestRecords[key] || {}), loading: true, error: "" };
    repaint();
    try {
      await fetchRecords(key, r);
    } catch (err) {
      state.ingestRecords[key] = { data: null, scanning: false, error: err?.message || "No se pudo calcular registros." };
    }
    repaint();
    if (state.ingestRecords[key] && state.ingestRecords[key].scanning) scheduleRecordsPoll(key);
  }
  function scheduleRecordsPoll(key) {
    if (state.ingestRecordsPollTimer) return;
    state.ingestRecordsPollTimer = window.setTimeout(async () => {
      state.ingestRecordsPollTimer = null;
      const r = recordsRange();
      if (!r || recordsKey() !== key) return; // cambió zona/rango: descarta
      try { await fetchRecords(key, r); } catch {}
      repaint();
      const cur = state.ingestRecords[key];
      if (cur && cur.scanning) scheduleRecordsPoll(key);
    }, 4000);
  }

  // Vista "Por área" en modo registros: áreas con total de filas; al expandir,
  // las TABLAS que ingestó esa área con archivos, peso y registros.
  function recordsAreaList(rec) {
    const zone = state.ingestZone;
    const byArea = (rec.data && rec.data.byArea) || {};
    const areas = Object.keys(byArea)
      .map((area) => ({ area, files: Number(byArea[area].files) || 0, rows: Number(byArea[area].rows) || 0 }))
      .sort((a, b) => b.rows - a.rows);
    const head = `<h3>Por origen · registros</h3>`;
    if (!areas.length) return `<div class="homeTopList">${head}<p class="catalogEmpty">Sin registros en el rango.</p></div>`;
    const rows = areas.map((a) => {
      const open = state.ingestOpenArea === a.area;
      return `
        <div class="homeSvcRow">
          <div class="homeSvcMain">
            <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-ingest-area="${escapeAttribute(a.area)}" title="Ver archivos de ${escapeAttribute(a.area)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>
            <span class="homeSvcName">${escapeHtml(a.area)}</span>
            <span class="homeTopMeta homeSvcAmount">${a.rows.toLocaleString("en-US")} registros · ${a.files.toLocaleString("en-US")} archivos</span>
          </div>
          ${open ? `<div class="homeSvcDetail">${recordsTables(byArea[a.area], a.area)}</div>` : ""}
        </div>`;
    }).join("");
    return `<div class="homeTopList">${head}${rows}</div>`;
  }
  function tableSortHeader(key, label, numeric) {
    const active = tableSortKey === key;
    const arrow = active ? (tableSortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="${numeric ? "num " : ""}sortableTh${active ? " active" : ""}" data-ingest-tablesort="${key}">${label}${arrow}</th>`;
  }
  function recordsTables(areaObj, area) {
    const t = (areaObj && areaObj.tables) || {};
    const list = Object.values(t)
      .map((v) => ({ name: v.name || "", status: v.status || "", files: Number(v.files) || 0, rows: Number(v.rows) || 0 }));
    return filesGroupTable(list, `area:${area || ""}`);
  }
  // Agrupa los archivos por NOMBRE: una fila por archivo con los totales sumados.
  // Si un archivo tiene >1 estado, la celda Estado se despliega al detalle por estado
  // (en vez de duplicar el nombre del archivo una vez por estado).
  function filesGroupTable(list, ctxKey) {
    const groups = {};
    for (const x of list) {
      const name = x.name || "";
      const g = groups[name] || (groups[name] = { name, files: 0, rows: 0, statuses: [] });
      g.files += Number(x.files) || 0;
      g.rows += Number(x.rows) || 0;
      g.statuses.push({ status: x.status || "", files: Number(x.files) || 0, rows: Number(x.rows) || 0 });
    }
    const key = (tableSortKey === "name" || tableSortKey === "files" || tableSortKey === "rows") ? tableSortKey : "rows";
    const arr = Object.values(groups).sort((a, b) => {
      const cmp = key === "name" ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a[key] - b[key];
      return tableSortDir === "asc" ? cmp : -cmp;
    });
    if (!arr.length) return `<p class="catalogEmpty">Sin archivos.</p>`;
    return `
      <table class="homeSvcTable">
        <thead><tr>${tableSortHeader("name", "Archivo", false)}<th>Estado</th>${tableSortHeader("files", "Archivos", true)}${tableSortHeader("rows", "Registros", true)}</tr></thead>
        <tbody>
          ${arr.map((g) => {
            const multi = g.statuses.length > 1;
            const fkey = `${ctxKey}|${g.name}`;
            const open = !!state.ingestOpenFiles[fkey];
            const estado = multi
              ? `<button type="button" class="fileStatusToggle ${open ? "open" : ""}" data-ingest-file="${escapeAttribute(fkey)}" aria-expanded="${open ? "true" : "false"}" title="Ver desglose por estado"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>${g.statuses.length} estados</button>`
              : ingStatus(g.statuses[0].status);
            const detail = (multi && open)
              ? g.statuses.slice().sort((a, b) => b.rows - a.rows).map((s) => `<tr class="fileStatusRow">
                  <td></td>
                  <td>${ingStatus(s.status)}</td>
                  <td class="homeSvcQty">${s.files.toLocaleString("en-US")}</td>
                  <td class="homeSvcQty">${s.rows.toLocaleString("en-US")}</td>
                </tr>`).join("")
              : "";
            return `<tr>
              <td>${escapeHtml(g.name)}</td>
              <td>${estado}</td>
              <td class="homeSvcQty">${g.files.toLocaleString("en-US")}</td>
              <td class="homeSvcQty">${g.rows.toLocaleString("en-US")}</td>
            </tr>${detail}`;
          }).join("")}
        </tbody>
      </table>`;
  }
  function ingStatus(s) {
    if (!s) return "";
    const cls = s === "NUEVO" ? "ingStatusNew" : s === "MODIFICADO" ? "ingStatusMod" : "ingStatusOk";
    return `<span class="ingStatus ${cls}">${escapeHtml(s)}</span>`;
  }
  // Vista "Por fecha" en modo registros: registros por día (sumando áreas).
  function recordsDayList(rec) {
    const zone = state.ingestZone;
    const byArea = (rec.data && rec.data.byArea) || {};
    const perDay = {};
    for (const area of Object.keys(byArea)) {
      const bd = byArea[area].byDay || {};
      for (const d of Object.keys(bd)) {
        const agg = perDay[d] || (perDay[d] = { rows: 0, count: 0 });
        agg.rows += Number(bd[d].rows) || 0;
        agg.count += Number(bd[d].files) || 0;
      }
    }
    const sortKey = ["date", "rows", "count"].includes(daySortKey) ? daySortKey : "date";
    const entries = Object.keys(perDay).map((d) => ({ day: d, ...perDay[d] }));
    entries.sort((x, y) => {
      const cmp = sortKey === "date" ? (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) : x[sortKey] - y[sortKey];
      return daySortDir === "asc" ? cmp : -cmp;
    });
    const head = `<h3>Por fecha de ingesta · registros</h3>`;
    if (!entries.length) return `<div class="homeTopList">${head}<p class="catalogEmpty">Sin registros en el rango.</p></div>`;
    const rows = entries.map((e) => {
      const open = state.ingestOpenDay === e.day;
      return `
        <tr class="homeDayTr" data-ingest-day="${escapeAttribute(e.day)}">
          <td class="homeDayCellDate"><span class="homeDayToggle ${open ? "open" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></span>${escapeHtml(e.day)}</td>
          <td class="homeDayCellNum">${e.rows.toLocaleString("en-US")}</td>
          <td class="homeDayCellNum">${e.count.toLocaleString("en-US")}</td>
        </tr>
        ${open ? `<tr class="homeDayDetailTr"><td colspan="3">${recordsDayAreas(rec, e.day)}</td></tr>` : ""}`;
    }).join("");
    return `<div class="homeTopList">${head}
      <table class="homeDailyTable">
        <thead><tr>${daySortHeader("date", "Día", false)}${daySortHeader("rows", "Registros", true)}${daySortHeader("count", "Archivos", true)}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
  // Áreas ingestadas un día concreto (vista Registros · Por fecha → expandir día).
  // Cada área es a su vez expandible → sus TABLAS de ese día (carga bajo demanda).
  function recordsDayAreas(rec, day) {
    const byArea = (rec.data && rec.data.byArea) || {};
    const areas = Object.keys(byArea)
      .map((area) => {
        const v = byArea[area].byDay && byArea[area].byDay[day];
        return v ? { area, rows: Number(v.rows) || 0, files: Number(v.files) || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rows - a.rows);
    if (!areas.length) return `<p class="catalogEmpty">Sin ingestas registradas ese día.</p>`;
    return areas.map((a) => {
      const open = state.ingestOpenDayArea === a.area;
      return `
        <div class="homeSvcRow">
          <div class="homeSvcMain">
            <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-ingest-dayarea="${escapeAttribute(a.area)}" title="Ver archivos de ${escapeAttribute(a.area)} ese día"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>
            <span class="homeSvcName">${escapeHtml(a.area)}</span>
            <span class="homeTopMeta homeSvcAmount">${a.rows.toLocaleString("en-US")} registros · ${a.files.toLocaleString("en-US")} archivos</span>
          </div>
          ${open ? `<div class="homeSvcDetail">${dayAreaTables(a.area, day)}</div>` : ""}
        </div>`;
    }).join("");
  }
  // Archivos de un (origen, día), cargados bajo demanda desde el backend (Athena puntual).
  function dayAreaTables(area, day) {
    const key = `${state.ingestZone}|${area}|${day}`;
    const cur = state.ingestDayTables[key];
    if (!cur || cur.loading) return `<p class="catalogEmpty">Cargando archivos…</p>`;
    if (cur.error) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(cur.error)}</p>`;
    const list = (cur.data || []).map((x) => ({ name: x.name || "", status: x.status || "", files: Number(x.files) || 0, rows: Number(x.rows) || 0 }));
    if (!list.length) return `<p class="catalogEmpty">Sin archivos ese día.</p>`;
    return filesGroupTable(list, `day:${day}|area:${area}`);
  }
  function toggleDayArea(area) {
    if (state.ingestOpenDayArea === area) { state.ingestOpenDayArea = null; repaint(); return; }
    state.ingestOpenDayArea = area;
    repaint();
    ensureDayTables(area, state.ingestOpenDay);
  }
  async function ensureDayTables(area, day) {
    if (!area || !day) return;
    const key = `${state.ingestZone}|${area}|${day}`;
    const cur = state.ingestDayTables[key];
    if (cur && (cur.loading || cur.data || cur.error)) return;
    state.ingestDayTables[key] = { loading: true };
    repaint();
    try {
      const p = await apiRequest(
        `api/datalake/ingest/records?bucket=${encodeURIComponent(state.ingestBucket)}`
        + `&zone=${encodeURIComponent(state.ingestZone)}&area=${encodeURIComponent(area)}&day=${encodeURIComponent(day)}`);
      state.ingestDayTables[key] = { data: p.data.tables || [], loading: false };
    } catch (err) {
      state.ingestDayTables[key] = { error: err?.message || "No se pudo cargar las tablas.", loading: false };
    }
    repaint();
  }
  function drawRecordsChart() {
    const Chart = window.Chart;
    if (!Chart) return;
    const iEl = elements.contentPanel.querySelector("#ingestChart");
    if (!iEl) return;
    const rec = currentRecords();
    if (!rec || !rec.data) return;
    const byArea = rec.data.byArea || {};
    const perDay = {};
    for (const a of Object.keys(byArea)) {
      const bd = byArea[a].byDay || {};
      for (const d of Object.keys(bd)) perDay[d] = (perDay[d] || 0) + (Number(bd[d].rows) || 0);
    }
    const days = Object.keys(perDay).sort();
    if (!days.length) return;
    const data = days.map((d) => perDay[d]);
    state.homeCharts.ingest = new Chart(iEl, {
      type: "bar",
      data: { labels: days.map((d) => d.slice(5)), datasets: [{ data, backgroundColor: chartColors[2] }] },
      options: {
        onClick: (evt, els) => {
          if (!els || !els.length) return;
          const day = days[els[0].index];
          if (!day) return;
          state.ingestGroupBy = "date";
          state.ingestOpenDay = day;
          repaint();
        },
        onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => days[items[0].dataIndex] || "",
            label: (c) => `${c.parsed.y.toLocaleString("en-US")} registros`,
          } },
        },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        maintainAspectRatio: false,
      },
    });
  }

  function bindEvents() {
    const scanBtn = elements.contentPanel.querySelector("#ingestScanBtn");
    if (scanBtn) scanBtn.addEventListener("click", () => scanIngest());
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-zone]")) {
      btn.addEventListener("click", () => {
        if (state.ingestZone === btn.dataset.ingestZone) return;
        state.ingestZone = btn.dataset.ingestZone;
        state.ingestOpenArea = null;
        state.ingestOpenDay = null;
        repaint();
        ensureDetailForRange();
      });
    }
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-metric]")) {
      btn.addEventListener("click", () => {
        if (state.ingestMetric === btn.dataset.ingestMetric) return;
        state.ingestMetric = btn.dataset.ingestMetric;
        // "Todo" no aplica a Registros: si venías en "Todo", cae a 90 días.
        if (state.ingestMetric === "records" && state.ingestRangePreset === "all") state.ingestRangePreset = "90d";
        state.ingestOpenArea = null;
        repaint();
      });
    }
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-area]")) {
      btn.addEventListener("click", () => toggleIngestArea(btn.dataset.ingestArea));
    }
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-groupby]")) {
      btn.addEventListener("click", () => {
        if (state.ingestGroupBy === btn.dataset.ingestGroupby) return;
        state.ingestGroupBy = btn.dataset.ingestGroupby;
        repaint();
        // La vista "Por fecha" necesita el detalle por área para pivotar.
        if (state.ingestGroupBy === "date" && !state.ingestDetail[state.ingestZone]) loadIngestDetail(state.ingestZone);
      });
    }
    for (const tr of elements.contentPanel.querySelectorAll("[data-ingest-day]")) {
      tr.addEventListener("click", () => toggleIngestDay(tr.dataset.ingestDay));
    }
    // Expandir un área dentro de un día (Registros · Por fecha) → sus tablas.
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-dayarea]")) {
      btn.addEventListener("click", () => toggleDayArea(btn.dataset.ingestDayarea));
    }
    // Desplegar el detalle por estado de un archivo agrupado.
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-file]")) {
      btn.addEventListener("click", () => {
        const k = btn.dataset.ingestFile;
        if (state.ingestOpenFiles[k]) delete state.ingestOpenFiles[k];
        else state.ingestOpenFiles[k] = true;
        repaint();
      });
    }
    // Orden de la tabla diaria por columna (Día / Archivos / Peso).
    for (const th of elements.contentPanel.querySelectorAll("[data-ingest-daysort]")) {
      th.addEventListener("click", () => {
        const k = th.dataset.ingestDaysort;
        if (daySortKey === k) daySortDir = daySortDir === "asc" ? "desc" : "asc";
        else { daySortKey = k; daySortDir = "desc"; }
        repaint();
      });
    }
    // Orden de la tabla de tablas (Registros · Por área): Tabla / Archivos / Peso / Registros.
    for (const th of elements.contentPanel.querySelectorAll("[data-ingest-tablesort]")) {
      th.addEventListener("click", () => {
        const k = th.dataset.ingestTablesort;
        if (tableSortKey === k) tableSortDir = tableSortDir === "asc" ? "desc" : "asc";
        else { tableSortKey = k; tableSortDir = k === "name" ? "asc" : "desc"; }
        repaint();
      });
    }
    // Rango de fechas: presets + Desde/Hasta personalizado.
    for (const btn of elements.contentPanel.querySelectorAll("[data-ingest-range]")) {
      btn.addEventListener("click", () => {
        state.ingestRangePreset = btn.dataset.ingestRange;
        state.ingestRangeFrom = "";
        state.ingestRangeTo = "";
        repaint();
        ensureDetailForRange();
      });
    }
    const fromEl = elements.contentPanel.querySelector("#ingestFrom");
    if (fromEl) fromEl.addEventListener("change", () => {
      state.ingestRangePreset = "custom";
      state.ingestRangeFrom = fromEl.value;
      repaint();
      ensureDetailForRange();
    });
    const toEl = elements.contentPanel.querySelector("#ingestTo");
    if (toEl) toEl.addEventListener("change", () => {
      state.ingestRangePreset = "custom";
      state.ingestRangeTo = toEl.value;
      repaint();
      ensureDetailForRange();
    });
    // En modo registros, asegura el conteo del rango actual (cache o cálculo async).
    if (state.ingestMetric === "records") ensureRecords();
  }

  // Con un rango activo, los totales por área se calculan del detalle: cárgalo.
  function ensureDetailForRange() {
    const b = rangeBounds();
    const ranged = !(b.from === null && b.to === null);
    if (ranged && state.ingestZone && !state.ingestDetail[state.ingestZone]) {
      loadIngestDetail(state.ingestZone);
    }
  }

  // Chart.js ya está cargado por el módulo Inicio antes de llamar a drawChart.
  function drawChart() {
    if (state.ingestMetric === "records") { drawRecordsChart(); return; }
    const Chart = window.Chart;
    if (!Chart) return;
    const iEl = elements.contentPanel.querySelector("#ingestChart");
    if (!iEl || !state.ingestData || !state.ingestZone) return;
    const z = state.ingestData.zones[state.ingestZone];
    if (!z || !z.byDay || !Object.keys(z.byDay).length) return;
    const b = rangeBounds();
    const days = Object.keys(z.byDay).filter((d) => inRange(d, b)).sort();
    if (!days.length) return;
    const bytes = state.ingestMetric === "bytes";
    const data = days.map((d) => bytes ? Number(z.byDay[d].bytes) / 1e9 : Number(z.byDay[d].count));
    state.homeCharts.ingest = new Chart(iEl, {
      type: "bar",
      data: { labels: days.map((d) => d.slice(5)), datasets: [{ data, backgroundColor: chartColors[2] }] },
      options: {
        // Clic en una barra → ver qué se ingestó ese día (vista "Por fecha").
        onClick: (evt, els) => {
          if (!els || !els.length) return;
          const day = days[els[0].index];
          if (!day) return;
          state.ingestGroupBy = "date";
          state.ingestOpenDay = day;
          repaint();
          if (!state.ingestDetail[state.ingestZone]) loadIngestDetail(state.ingestZone);
        },
        onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => days[items[0].dataIndex] || "",
            label: (c) => bytes ? `${c.parsed.y.toFixed(2)} GB` : `${c.parsed.y} archivos`,
          } },
        },
        scales: { y: { beginAtZero: true, ticks: { precision: bytes ? 2 : 0 } } },
        maintainAspectRatio: false,
      },
    });
  }

  return { sectionHtml: ingestSection, bindEvents, drawChart, ensure: ensureIngest };
}
