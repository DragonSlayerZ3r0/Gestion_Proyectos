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
    const presets = [["all", "Todo"], ["30d", "30 días"], ["90d", "90 días"], ["year", "Este año"]];
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
      const zoneTabs = zones.map((zn) => `<button type="button" class="homeViewBtn ${zn === zone ? "active" : ""}" data-ingest-zone="${escapeAttribute(zn)}">${escapeHtml(zoneLabel(zn))}</button>`).join("");
      const metricTabs = `
        <button type="button" class="homeViewBtn ${metric === "count" ? "active" : ""}" data-ingest-metric="count">Archivos</button>
        <button type="button" class="homeViewBtn ${metric === "bytes" ? "active" : ""}" data-ingest-metric="bytes">Peso</button>`;
      const b = rangeBounds();
      const rt = z ? rangeTotals(z.byDay, b) : { count: 0, bytes: 0 };
      const rangeNote = (b.from === null && b.to === null) ? "todo el histórico" : "en el rango";
      const totals = `${rt.count.toLocaleString("en-US")} archivos · ${formatBytes(rt.bytes)} <span class="homeCostAgo">(${rangeNote})</span>`;
      const byArea = state.ingestGroupBy !== "date";
      const groupTabs = `
        <button type="button" class="homeViewBtn ${byArea ? "active" : ""}" data-ingest-groupby="area">Por área</button>
        <button type="button" class="homeViewBtn ${!byArea ? "active" : ""}" data-ingest-groupby="date">Por fecha</button>`;
      inner = `
        <div class="ingestControls">
          <div class="homeViewToggle" role="group" aria-label="Zona">${zoneTabs}</div>
          <div class="homeViewToggle" role="group" aria-label="Métrica">${metricTabs}</div>
          <span class="homeTopMeta">${totals}</span>
        </div>
        ${rangeControl()}
        <div class="homeChartBox"><h3>Cargas por día · ${metric === "count" ? "archivos" : "peso"} (${escapeHtml(zoneLabel(zone))})</h3><canvas id="ingestChart"></canvas></div>
        <div class="ingestControls"><div class="homeViewToggle" role="group" aria-label="Agrupar por">${groupTabs}</div></div>
        ${byArea ? ingestAreaList(z, b) : ingestDayList(z, b)}`;
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
    if (state.ingestOpenDay === day) { state.ingestOpenDay = null; repaint(); return; }
    state.ingestOpenDay = day;
    repaint();
    if (!state.ingestDetail[state.ingestZone]) loadIngestDetail(state.ingestZone);
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
    // Orden de la tabla diaria por columna (Día / Archivos / Peso).
    for (const th of elements.contentPanel.querySelectorAll("[data-ingest-daysort]")) {
      th.addEventListener("click", () => {
        const k = th.dataset.ingestDaysort;
        if (daySortKey === k) daySortDir = daySortDir === "asc" ? "desc" : "asc";
        else { daySortKey = k; daySortDir = "desc"; }
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
