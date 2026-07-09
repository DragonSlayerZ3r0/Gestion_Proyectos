// @ts-nocheck
// Módulo Inicio (dashboard). Se construye con inyección de dependencias: recibe
// el estado y los helpers compartidos del shell, sin acoplarse al resto de la app.
import { createDatalakeModule } from "./datalake";

export function createHomeModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel, mdLite, animateViewEnter } = ctx;

      // La lista de cuentas la entrega el backend (fuente única en el stack CDK).
      // Se carga EN PARALELO, sin bloquear la carga de costos: cuando llega,
      // refresca el selector sin volver a pedir costos. Carga única (dedupe).
      let accountsLoading = false;
      async function ensureCostAccounts() {
        if (state.homeCostAccounts || accountsLoading) return;
        accountsLoading = true;
        try {
          const payload = await apiRequest("api/home/cost-accounts");
          state.homeCostAccounts = (payload.data.accounts || []).map((a) => ({
            id: a.id,
            label: `${a.name} (${a.id})`,
          }));
          // Si la cuenta seleccionada ya no existe en la lista, usa la primera.
          if (state.homeCostAccounts.length && !state.homeCostAccounts.some((a) => a.id === state.homeCostAccount)) {
            state.homeCostAccount = state.homeCostAccounts[0].id;
          }
        } catch {
          state.homeCostAccounts = [];
        } finally {
          accountsLoading = false;
        }
        // Si la pestaña de costos está visible, refresca solo el selector.
        if (state.homeTab === "facturacion") repaintCostPanel();
      }

      // Cuentas para pintar el selector: las del backend o, mientras cargan, la
      // seleccionada actual como única opción (evita un selector vacío).
      function costAccountOptions() {
        if (state.homeCostAccounts && state.homeCostAccounts.length) return state.homeCostAccounts;
        return [{ id: state.homeCostAccount, label: state.homeCostAccount }];
      }
      const CHART_COLORS = ["#2f8f83", "#4f9ed8", "#e0a93b", "#9b6dd0", "#d96d6d", "#5cb85c", "#7a8a99", "#c97fb0"];

      // Sub-módulo del monitoreo de cargas (pestaña Data Lake). Inicio lo compone
      // y le delega render/eventos/gráfico; repaint reusa el paint de Inicio.
      const datalakeModule = createDatalakeModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes,
        catalogSyncedLabel, homeDateTimeLabel, chartColors: CHART_COLORS,
        repaint: () => { if (state.homeTab === "datalake") paintHome(); },
      });

      // Orden de las tablas de Facturación (compartido entre repintados).
      let dailySortKey = "date";    // Detalle diario: "date"|"total"|"delta"
      let dailySortDir = "desc";
      let usageSortKey = "amount";  // Tipos de uso: "usageType"|"quantity"|"amount"
      let usageSortDir = "desc";

      function loadChartJs() {
        return new Promise((resolve, reject) => {
          if (window.Chart) { resolve(); return; }
          const s = document.createElement("script");
          // Auto-hospedado en /vendor/ (chart.js 4.4.1): laptops corporativas con
          // salida restringida solo alcanzan dominios de AWS — no usar CDNs externos.
          s.src = "/vendor/chart.umd.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("No fue posible cargar Chart.js."));
          document.head.appendChild(s);
        });
      }

      function destroyHomeCharts() {
        for (const c of Object.values(state.homeCharts || {})) {
          try { c.destroy(); } catch {}
        }
        state.homeCharts = {};
      }

      function currentMonthPeriod() {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() }; // month 0-based
      }

      function periodRange(period) {
        const start = new Date(Date.UTC(period.year, period.month, 1));
        const end = new Date(Date.UTC(period.year, period.month + 1, 1));
        const iso = (d) => d.toISOString().slice(0, 10);
        return { start: iso(start), end: iso(end) };
      }

      function periodOptions() {
        const opts = [];
        const now = new Date();
        for (let i = 0; i < 6; i++) {
          const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
          opts.push({ year: d.getUTCFullYear(), month: d.getUTCMonth(), label: d.toLocaleDateString("es-GT", { year: "numeric", month: "long", timeZone: "UTC" }) });
        }
        return opts;
      }

      async function renderHome() {
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.contentPanel.className = "contentGrid homeGrid";
        elements.viewTitle.textContent = "Panel";
        if (!state.homeCostPeriod) state.homeCostPeriod = currentMonthPeriod();
        destroyHomeCharts();
        state.homeSummary = null;
        state.homeSummaryError = "";
        // Pre-carga la lista de cuentas (solo admins) para que el selector de
        // Facturación esté listo al abrir la pestaña, sin bloquear el resumen.
        if ((state.profile?.user?.roles || []).includes("admin")) ensureCostAccounts();
        paintHome();
        try {
          const payload = await apiRequest("api/home/summary");
          state.homeSummary = payload.data;
        } catch (err) {
          state.homeSummaryError = err?.message || "No se pudo cargar el resumen.";
        }
        paintHome();
        // Si la pestaña activa es Data Lake, carga el monitoreo de cargas.
        if (state.homeTab === "datalake") datalakeModule.ensure();
      }

      async function loadHomeCosts(force) {
        state.homeCostsLoading = true;
        state.homeCostsError = "";
        state.homeCosts = null;
        clearServiceDetail();
        clearDaily();
        repaintCostPanel();
        // La lista de cuentas se carga en paralelo (no bloquea los costos).
        ensureCostAccounts();
        // Si el análisis de picos ya está cacheado, se muestra solo (sin costo);
        // si no, queda el botón "Analizar picos". No bloquea ni gasta consulta.
        loadDailyByService({ cachedOnly: true, silent: true });
        const { start, end } = periodRange(state.homeCostPeriod);
        try {
          const payload = await apiRequest(`api/home/costs?account=${encodeURIComponent(state.homeCostAccount)}&start=${start}&end=${end}${force ? "&force=1" : ""}`);
          state.homeCosts = payload.data;
        } catch (err) {
          state.homeCostsError = err?.message || "No se pudieron cargar los costos.";
        }
        state.homeCostsLoading = false;
        repaintCostPanel();
      }

      function paintHome() {
        // Guard anti "pintar encima": los sondeos asíncronos (escaneo de Athena,
        // cargas del Data Lake) siguen vivos si el usuario cambia de módulo; sin
        // esto re-renderizaban el contenido del Panel DENTRO de otro módulo
        // (p. ej. el monitoreo de Athena apareciendo dentro del Catálogo).
        if (state.activeModule !== "home") return;
        const isAdmin = (state.profile?.user?.roles || []).includes("admin");
        const s = state.homeSummary;

        // La pestaña "Resumen" (operativo de solicitudes) se eliminó (2026-07-06):
        // ese contenido es dominio de Solicitudes y vive allá como Tablero de avance.
        const catalogBlock = !s
          ? ""
          : `
          <article class="panel homePanel">
            <p class="eyebrow">Data Lake</p>
            <h2>Resumen de catálogo</h2>
            <div class="homeStatsRow">
              ${homeStatCard("Bases de datos", s.catalog.databases)}
              ${homeStatCard("Tablas", s.catalog.tables)}
              ${homeStatCard("Tamaño total", formatBytes(s.catalog.sizeBytes))}
            </div>
            <div class="homeTopList">
              <h3>Bases más grandes</h3>
              ${s.catalog.topDatabases.map((d) => `
                <div class="homeTopRow">
                  <span>${escapeHtml(d.name)}</span>
                  <span class="homeTopMeta">${d.tableCount} tablas · <b>${formatBytes(d.sizeBytes)}</b></span>
                </div>`).join("")}
            </div>
          </article>`;

        // Pestañas visibles según permisos (homeTabs de /api/me, asignables en
        // Administración). El backend ya resuelve los defaults: Facturación y
        // Athena sin configurar → solo admins. La verificación real está en el
        // backend (guards.ensure_home_tab); esto solo oculta/muestra.
        const homeTabs = state.profile?.homeTabs;
        // Compatibilidad: si el perfil no trae homeTabs (cache previa), los dos
        // básicos on y los sensibles según rol (mismo default que el backend).
        const canDatalake = !homeTabs || homeTabs.includes("home_datalake");
        const canFacturacion = homeTabs ? homeTabs.includes("home_facturacion") : isAdmin;
        const canAthena = homeTabs ? homeTabs.includes("home_athena") : isAdmin;

        const costBlock = !canFacturacion
          ? ""
          : `<article class="panel homePanel homeCostPanel" id="homeCostPanel">${costPanelInner()}</article>`;
        const tabs = [];
        if (canDatalake) tabs.push({ id: "datalake", label: "Data Lake" });
        if (canFacturacion) tabs.push({ id: "facturacion", label: "Facturación" });
        if (canAthena) tabs.push({ id: "athena", label: "Athena" });

        // Asegura que la pestaña activa exista entre las visibles (incluye a los
        // usuarios que tenían "resumen" activa antes de eliminarse esa pestaña).
        if (!tabs.some((t) => t.id === state.homeTab)) {
          state.homeTab = tabs.length ? tabs[0].id : "datalake";
        }
        const tab = state.homeTab;

        const tabBar = `
          <div class="homeTabs" role="tablist">
            ${tabs.map((t) => `<button type="button" class="homeTab ${tab === t.id ? "active" : ""}" data-home-tab="${t.id}">${escapeHtml(t.label)}</button>`).join("")}
          </div>`;

        let body;
        if (!tabs.length) {
          body = `<article class="panel"><p class="catalogEmpty">No tienes pestañas habilitadas en Inicio. Contacta a un administrador.</p></article>`;
        } else if (tab === "facturacion" && canFacturacion) {
          body = costBlock;
        } else if (tab === "athena" && canAthena) {
          body = athenaBlock();
        } else if (tab === "datalake") {
          const catalogPart = state.homeSummaryError
            ? `<article class="panel"><p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeSummaryError)}</p></article>`
            : !s
            ? `<article class="panel"><p class="catalogEmpty">Cargando catálogo…</p></article>`
            : catalogBlock;
          body = catalogPart + datalakeModule.sectionHtml();
        } else {
          body = `<article class="panel"><p class="catalogEmpty">Selecciona una pestaña.</p></article>`;
        }

        const savedScroll = elements.contentPanel.scrollTop;
        // El SQL de cada consulta tiene su propio scroll interno (.athenaSql); al
        // reemplazar el HTML se crean nodos nuevos y ese scroll se pierde (p. ej. al
        // marcar/desmarcar un antipatrón). Se guarda por qid y se restaura después.
        const sqlScroll = {};
        for (const el of elements.contentPanel.querySelectorAll(".athenaSql[data-sql-key]")) {
          if (el.dataset.sqlKey) sqlScroll[el.dataset.sqlKey] = el.scrollTop;
        }
        elements.contentPanel.innerHTML = tabBar + body;
        elements.contentPanel.scrollTop = savedScroll;
        for (const el of elements.contentPanel.querySelectorAll(".athenaSql[data-sql-key]")) {
          const v = sqlScroll[el.dataset.sqlKey];
          if (v) el.scrollTop = v;
        }
        bindHomeEvents();
        drawHomeCharts();
      }

      function costPanelInner() {
        return `
          <div class="homeCostHeader">
            <div><p class="eyebrow">Costos AWS</p><h2>Facturación</h2></div>
            <div class="homeCostControls">
              <div class="homeViewToggle" role="group" aria-label="Vista de costos">
                <button type="button" class="homeViewBtn ${state.homeCostView === "net" ? "active" : ""}" data-cost-view="net" title="Lo que realmente pagas (después de créditos)">Neto</button>
                <button type="button" class="homeViewBtn ${state.homeCostView === "gross" ? "active" : ""}" data-cost-view="gross" title="Lo que consumiste antes de aplicar créditos">Bruto</button>
              </div>
              <label>Cuenta
                <select id="homeAccountSelect">
                  ${costAccountOptions().map((a) => `<option value="${a.id}" ${a.id === state.homeCostAccount ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}
                </select>
              </label>
              <label>Periodo
                <select id="homePeriodSelect">
                  ${periodOptions().map((p) => `<option value="${p.year}-${p.month}" ${p.year === state.homeCostPeriod.year && p.month === state.homeCostPeriod.month ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
                </select>
              </label>
            </div>
          </div>
          ${renderCostBody()}`;
      }

      // Repinta SOLO el bloque de costos (no toca resumen ni catálogo) para evitar
      // que las gráficas operativas parpadeen al cambiar cuenta/periodo/vista.
      function repaintCostPanel() {
        const panel = elements.contentPanel.querySelector("#homeCostPanel");
        if (!panel) { paintHome(); return; }
        destroyCostCharts();
        panel.innerHTML = costPanelInner();
        bindHomeEvents();
        drawCostCharts();
      }

      function renderCostBody() {
        if (state.homeCostsLoading) return `<p class="catalogEmpty">Cargando costos…</p>`;
        if (state.homeCostsError) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeCostsError)}</p>`;
        const c = state.homeCosts;
        if (!c) return `<p class="catalogEmpty">Sin datos.</p>`;
        const concept = (t) => { const f = (c.concepts || []).find((x) => x.type === t); return f ? f.amount : "0.00"; };
        const gross = state.homeCostView === "gross";
        const cards = gross
          ? `
            ${homeCostCard("Uso", concept("Usage"))}
            ${homeCostCard("Soporte", concept("Support"))}
            ${homeCostCard("Impuestos", concept("Tax"))}
            ${homeCostCard("Costo bruto", c.gross, false, true)}`
          : `
            ${homeCostCard("Uso", concept("Usage"))}
            ${homeCostCard("Créditos", concept("Credit"), true)}
            ${homeCostCard("Soporte", concept("Support"))}
            ${homeCostCard("Impuestos", concept("Tax"))}
            ${homeCostCard("Neto a pagar", c.net, false, true)}`;
        return `
          <div class="homeCostFreshness">
            <span class="homeCostUpdated">Actualizado: <b>${homeDateTimeLabel(c.fetchedAt)}</b> <span class="homeCostAgo">(${catalogSyncedLabel(c.fetchedAt)}${c.cached ? ", desde caché" : ""})</span></span>
            <button id="homeRefreshCosts" class="tinyButton" type="button" title="Vuelve a consultar AWS (tiene un costo mínimo). Cost Explorer se actualiza solo unas 3 veces al día.">Actualizar ahora</button>
          </div>
          <p class="homeCostHint">${gross ? "Bruto: lo consumido antes de aplicar créditos." : "Neto: lo que realmente pagas después de aplicar créditos."}</p>
          <div class="homeStatsRow homeCostCards">${cards}</div>
          <div class="homeChartsRow">
            <div class="homeChartBox"><h3>Costo por servicio (top 10) · ${gross ? "bruto" : "neto"}</h3><canvas id="homeServiceChart"></canvas></div>
            <div class="homeChartBox"><h3>Tendencia diaria (${gross ? "bruto" : "neto"})</h3><canvas id="homeDailyChart"></canvas></div>
          </div>
          ${dailySpikeSection()}
          ${serviceDetailSection(gross ? (c.grossByService || []) : (c.byService || []))}
          ${(c.creditsByService || []).length ? `
            <div class="homeTopList">
              ${sectionTitle("credits", "Créditos por servicio", state.homeCreditsCollapsed)}
              ${state.homeCreditsCollapsed ? "" : c.creditsByService.map((s) => `<div class="homeTopRow"><span>${escapeHtml(s.service)}</span><span class="homeTopMeta homeCredit">$${fmtUsd(s.amount)}</span></div>`).join("")}
            </div>` : ""}
        `;
      }

      // Título de sección colapsable: caret + texto, toggle con data-section-toggle.
      function sectionTitle(key, label, collapsed) {
        return `<h3 class="homeSectionTitle ${collapsed ? "collapsed" : ""}" data-section-toggle="${key}" role="button" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}">
            <span class="homeSectionCaret"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></span>${escapeHtml(label)}
          </h3>`;
      }

      // Lista de servicios con ícono ▸ que expande el desglose por tipo de uso.
      function serviceDetailSection(services) {
        if (!services.length) return "";
        const chevron = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"></path></svg>`;
        const collapsed = state.homeDetailCollapsed;
        const rows = collapsed ? "" : services.map((s) => {
          const open = state.homeCostDetailService === s.service;
          return `
            <div class="homeSvcRow">
              <div class="homeSvcMain">
                <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-cost-detail="${escapeAttribute(s.service)}"
                  aria-expanded="${open ? "true" : "false"}" aria-label="Ver detalle de uso de ${escapeAttribute(s.service)}" title="Ver detalle de uso">${chevron}</button>
                <span class="homeSvcName">${escapeHtml(s.service)}</span>
                <span class="homeTopMeta homeSvcAmount">$${fmtUsd(s.amount)}</span>
              </div>
              ${open ? `<div class="homeSvcDetail">${serviceDetailBody()}</div>` : ""}
            </div>`;
        }).join("");
        return `
          <div class="homeTopList homeSvcList">
            ${sectionTitle("detail", "Detalle por servicio", collapsed)}
            ${rows}
          </div>`;
      }

      // Cantidad legible: separador de miles + unidad (p. ej. "210,185,825 Requests").
      function formatQty(qty, unit) {
        if (!qty) return "—";
        const n = parseFloat(qty);
        const num = Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : qty;
        return `${escapeHtml(num)}${unit ? ` <span class="homeSvcUnit">${escapeHtml(unit)}</span>` : ""}`;
      }

      // Importe en dólares con separador de miles.
      function fmtUsd(amount) {
        const n = parseFloat(amount);
        return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : escapeHtml(amount);
      }

      // Tabla de tipos de uso reutilizable (detalle mensual y detalle por día).
      function usageSortHeader(key, label, numeric) {
        const active = usageSortKey === key;
        const arrow = active ? (usageSortDir === "asc" ? " ▲" : " ▼") : "";
        return `<th class="sortableTh${numeric ? " num" : ""}${active ? " active" : ""}" data-usage-sort="${key}">${label}${arrow}</th>`;
      }

      function dailySortHeader(key, label, numeric) {
        const active = dailySortKey === key;
        const arrow = active ? (dailySortDir === "asc" ? " ▲" : " ▼") : "";
        return `<th class="${numeric ? "homeDayCellNum " : ""}sortableTh${active ? " active" : ""}" data-daily-sort="${key}">${label}${arrow}</th>`;
      }

      function usageDetailTable(d, emptyMsg) {
        if (!d || !d.items) return `<p class="catalogEmpty">Sin datos.</p>`;
        if (!d.items.length) return `<p class="catalogEmpty">${escapeHtml(emptyMsg || "Sin tipos de uso con costo en el periodo.")}</p>`;
        const items = d.items.slice().sort((a, b) => {
          const cmp = usageSortKey === "usageType"
            ? (a.usageType < b.usageType ? -1 : a.usageType > b.usageType ? 1 : 0)
            : (parseFloat(a[usageSortKey]) || 0) - (parseFloat(b[usageSortKey]) || 0);
          return usageSortDir === "asc" ? cmp : -cmp;
        });
        return `
          <table class="homeSvcTable">
            <thead><tr>${usageSortHeader("usageType", "Tipo de uso", false)}${usageSortHeader("quantity", "Cantidad", true)}${usageSortHeader("amount", "Costo", true)}</tr></thead>
            <tbody>
              ${items.map((it) => `<tr>
                <td>${escapeHtml(it.usageType)}</td>
                <td class="homeSvcQty">${formatQty(it.quantity, it.unit)}</td>
                <td class="homeSvcAmt">$${fmtUsd(it.amount)}</td>
              </tr>`).join("")}
            </tbody>
          </table>`;
      }

      function serviceDetailBody() {
        if (state.homeCostDetailLoading) return `<p class="catalogEmpty">Cargando detalle…</p>`;
        if (state.homeCostDetailError) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeCostDetailError)}</p>`;
        return usageDetailTable(state.homeCostDetail);
      }

      async function loadServiceDetail(service) {
        // Toggle: si ya está abierto ese servicio, lo cierra.
        if (state.homeCostDetailService === service) {
          state.homeCostDetailService = null;
          state.homeCostDetail = null;
          state.homeCostDetailError = "";
          repaintCostPanel();
          return;
        }
        state.homeCostDetailService = service;
        state.homeCostDetail = null;
        state.homeCostDetailError = "";
        state.homeCostDetailLoading = true;
        repaintCostPanel();
        const { start, end } = periodRange(state.homeCostPeriod);
        try {
          const payload = await apiRequest(`api/home/costs/detail?account=${encodeURIComponent(state.homeCostAccount)}&service=${encodeURIComponent(service)}&start=${start}&end=${end}`);
          state.homeCostDetail = payload.data;
        } catch (err) {
          state.homeCostDetailError = err?.message || "No se pudo cargar el detalle.";
        }
        state.homeCostDetailLoading = false;
        repaintCostPanel();
      }

      // Limpia el detalle abierto (al cambiar cuenta/periodo/vista o recargar).
      function clearServiceDetail() {
        state.homeCostDetailService = null;
        state.homeCostDetail = null;
        state.homeCostDetailError = "";
        state.homeCostDetailLoading = false;
      }

      // ── Variación diaria (detección de picos) ────────────────────────────────

      function clearDaily() {
        state.homeDaily = null;
        state.homeDailyLoading = false;
        state.homeDailyError = "";
        state.homeDailyOpenDate = null;
        state.homeDailyDetailKey = null;
        state.homeDailyDetail = null;
        state.homeDailyDetailLoading = false;
        state.homeDailyDetailError = "";
      }

      function dayLabel(iso) {
        const d = new Date(`${iso}T00:00:00Z`);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString("es-GT", { day: "2-digit", month: "short", timeZone: "UTC" });
      }

      function dayPlusOne(iso) {
        const d = new Date(`${iso}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      }

      // Calcula, por día, el total y la variación (Δ) contra el día anterior, más
      // qué servicios subieron ese día. Devuelve también el mayor pico.
      function computeDailyDeltas(days) {
        const rows = [];
        let topSpike = null;
        for (let i = 0; i < days.length; i++) {
          const day = days[i];
          const prev = i > 0 ? days[i - 1] : null;
          const total = parseFloat(day.total) || 0;
          const prevTotal = prev ? (parseFloat(prev.total) || 0) : 0;
          const delta = prev ? total - prevTotal : 0;
          // Servicios que subieron vs el día anterior.
          let risers = [];
          if (prev) {
            const prevMap = {};
            for (const s of prev.services || []) prevMap[s.service] = parseFloat(s.amount) || 0;
            const curMap = {};
            for (const s of day.services || []) curMap[s.service] = parseFloat(s.amount) || 0;
            const names = new Set([...Object.keys(prevMap), ...Object.keys(curMap)]);
            for (const name of names) {
              const d = (curMap[name] || 0) - (prevMap[name] || 0);
              if (d > 0.005) risers.push({ service: name, delta: d, amount: curMap[name] || 0 });
            }
            risers.sort((a, b) => b.delta - a.delta);
          }
          const row = { date: day.date, total, delta, hasPrev: !!prev, risers, services: day.services || [] };
          rows.push(row);
          if (prev && (!topSpike || delta > topSpike.delta)) topSpike = row;
        }
        return { rows, topSpike };
      }

      function dailySpikeSection() {
        const collapsed = state.homeDailyCollapsed;
        const loaded = state.homeDaily && !state.homeDailyLoading && !state.homeDailyError;
        const actionBtn = state.homeDailyLoading ? "" : `<button type="button" id="homeAnalyzeDaily" class="tinyButton" title="${loaded ? "Vuelve a consultar (usa caché si está fresco)." : "Consulta el costo por día y servicio para detectar saltos (1 consulta a AWS, se cachea)."}">${loaded ? "Recalcular" : "Analizar picos"}</button>`;

        let body = "";
        if (!collapsed) {
          if (state.homeDailyLoading) {
            body = `<p class="catalogEmpty">Analizando variación diaria…</p>`;
          } else if (state.homeDailyError) {
            body = `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeDailyError)}</p>`;
          } else if (!state.homeDaily) {
            body = `<p class="homeCostHint">Detecta de un día a otro qué servicio elevó la factura.</p>`;
          } else {
            const { rows, topSpike } = computeDailyDeltas(state.homeDaily.days || []);
            const callout = topSpike && topSpike.delta > 0.005
              ? `<div class="homeSpikeCallout">
                   <strong>Mayor aumento:</strong> ${escapeHtml(dayLabel(topSpike.date))} ·
                   <span class="homeSpikeUp">+$${fmtUsd(topSpike.delta)}</span> vs el día anterior${
                     topSpike.risers.length ? ` · principal causa: <b>${escapeHtml(topSpike.risers[0].service)}</b> (+$${fmtUsd(topSpike.risers[0].delta)})` : ""}
                 </div>`
              : `<p class="homeCostHint">Sin aumentos relevantes de un día a otro en este periodo.</p>`;
            // Tabla ordenable por columna (Diario/Gasto/Variación). Por defecto
            // fecha descendente. Incluye el día 1 (su variación es $0.00).
            const ordered = rows.slice().sort((a, b) => {
              const cmp = dailySortKey === "date"
                ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
                : (a[dailySortKey] - b[dailySortKey]);
              return dailySortDir === "asc" ? cmp : -cmp;
            });
            const tableRows = ordered.map((r) => {
              const open = state.homeDailyOpenDate === r.date;
              const up = r.delta > 0.005;
              const varCell = !r.hasPrev
                ? `<span class="homeTopMeta">$0.00</span>`
                : up
                ? `<span class="homeSpikeUp">+$${fmtUsd(r.delta)}</span>`
                : r.delta < -0.005
                ? `<span class="homeSpikeDown">-$${fmtUsd(Math.abs(r.delta))}</span>`
                : `<span class="homeTopMeta">≈ $0.00</span>`;
              return `
                <tr class="homeDayTr ${up ? "isSpike" : ""}" data-daily-day="${escapeAttribute(r.date)}">
                  <td class="homeDayCellDate"><span class="homeDayToggle ${open ? "open" : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></span>${escapeHtml(dayLabel(r.date))}</td>
                  <td class="homeDayCellNum">$${fmtUsd(r.total)}</td>
                  <td class="homeDayCellNum">${varCell}</td>
                </tr>
                ${open ? `<tr class="homeDayDetailTr"><td colspan="3">${dayRisersBody(r)}</td></tr>` : ""}`;
            }).join("");
            const list = ordered.length
              ? `<table class="homeDailyTable">
                <thead><tr>${dailySortHeader("date", "Diario", false)}${dailySortHeader("total", "Gasto del día", true)}${dailySortHeader("delta", "Variación diaria", true)}</tr></thead>
                <tbody>${tableRows}</tbody>
              </table>`
              : `<p class="catalogEmpty">Sin datos diarios.</p>`;
            const fresh = state.homeDaily.fetchedAt
              ? `<p class="homeDailyFreshness">Calculado: <b>${homeDateTimeLabel(state.homeDaily.fetchedAt)}</b> <span class="homeCostAgo">(${catalogSyncedLabel(state.homeDaily.fetchedAt)}${state.homeDaily.cached ? ", desde caché" : ""})</span></p>`
              : "";
            body = `${fresh}${callout}${list}`;
          }
        }

        return `
          <div class="homeTopList homeDailyList">
            <div class="homeDailyHead">
              ${sectionTitle("daily", "Detalle diario", collapsed)}
              ${collapsed ? "" : actionBtn}
            </div>
            ${body}
          </div>`;
      }

      // Fila de un servicio dentro del detalle de un día, con drill al tipo de uso.
      // delta != null: muestra el aumento vs el día anterior (días con comparación).
      function serviceDrillRow(date, service, delta, amount) {
        const key = `${date}|${service}`;
        const open = state.homeDailyDetailKey === key;
        return `
          <div class="homeSvcRow">
            <div class="homeSvcMain">
              <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-daily-detail="${escapeAttribute(key)}"
                aria-expanded="${open ? "true" : "false"}" title="Ver tipos de uso de ${escapeAttribute(service)} ese día"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>
              <span class="homeSvcName">${escapeHtml(service)}</span>
              ${delta != null ? `<span class="homeSpikeUp homeDayRiserDelta">+$${fmtUsd(delta)}</span>` : ""}
              <span class="homeTopMeta homeSvcAmount">día $${fmtUsd(amount)}</span>
            </div>
            ${open ? `<div class="homeSvcDetail">${dailyDetailBody()}</div>` : ""}
          </div>`;
      }

      // Detalle al expandir un día. Con día previo: servicios que subieron (Δ).
      // Día base (sin previo, p. ej. el 1): gasto por servicio del día.
      function dayRisersBody(row) {
        if (!row.hasPrev) {
          if (!row.services || !row.services.length) return `<p class="catalogEmpty">Sin gasto registrado ese día.</p>`;
          return row.services.slice(0, 12).map((s) => serviceDrillRow(row.date, s.service, null, s.amount)).join("");
        }
        if (!row.risers.length) return `<p class="catalogEmpty">Ningún servicio aumentó respecto al día anterior.</p>`;
        return row.risers.slice(0, 12).map((s) => serviceDrillRow(row.date, s.service, s.delta, s.amount)).join("");
      }

      function dailyDetailBody() {
        if (state.homeDailyDetailLoading) return `<p class="catalogEmpty">Cargando detalle del día…</p>`;
        if (state.homeDailyDetailError) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeDailyDetailError)}</p>`;
        return usageDetailTable(state.homeDailyDetail, "Sin tipos de uso con costo ese día.") + responsiblesSection();
      }

      // Panel "Responsables (CloudTrail)": quién lanzó las acciones que generan
      // costo de este servicio ESE día. Carga diferida (botón). Atribuye por acción.
      function responsiblesSection() {
        const key = state.homeDailyDetailKey;
        if (!key) return "";
        if (state.homeRespLoading && state.homeRespKey === key) {
          return `<div class="homeRespBox"><p class="catalogEmpty">Buscando responsables en CloudTrail…</p></div>`;
        }
        if (state.homeRespError && state.homeRespKey === key) {
          return `<div class="homeRespBox"><p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeRespError)}</p></div>`;
        }
        if (state.homeRespKey !== key || !state.homeResp) {
          return `<div class="homeRespBox"><button type="button" class="tinyButton" data-load-responsibles="1" title="Consulta CloudTrail: quién lanzó las acciones que generan costo de este servicio ese día.">Ver responsables (CloudTrail)</button></div>`;
        }
        const d = state.homeResp;
        if (!d.supported) {
          return `<div class="homeRespBox"><p class="homeCostHint">Atribución por CloudTrail disponible para SageMaker; otros servicios próximamente.</p></div>`;
        }
        if (!d.actors || !d.actors.length) {
          return `<div class="homeRespBox"><h4>Responsables (CloudTrail)</h4><p class="catalogEmpty">Sin acciones de management ese día (puede ser uso automático/pipeline o data-plane no auditado).</p></div>`;
        }
        const rows = d.actors.map((a) => `
          <div class="homeRespRow">
            <span class="homeRespActor">${escapeHtml(a.actor)}</span>
            <span class="homeTopMeta">${a.actions.map((x) => `${escapeHtml(x.action)}×${x.count}`).join(", ")}${a.instances && a.instances.length ? ` · ${a.instances.map(escapeHtml).join(", ")}` : ""}</span>
          </div>`).join("");
        return `<div class="homeRespBox"><h4>Responsables (CloudTrail)</h4>${rows}<p class="homeCostHint">Atribución por <b>acción</b>, no por dólar. Eventos de management (no incluye data-plane como FeatureStore).</p></div>`;
      }

      async function loadResponsibles() {
        const key = state.homeDailyDetailKey;
        if (!key) return;
        const [date, service] = key.split("|");
        state.homeRespKey = key;
        state.homeResp = null;
        state.homeRespError = "";
        state.homeRespLoading = true;
        repaintCostPanel();
        try {
          const payload = await apiRequest(`api/home/costs/responsibles?account=${encodeURIComponent(state.homeCostAccount)}&service=${encodeURIComponent(service)}&start=${date}&end=${dayPlusOne(date)}`);
          state.homeResp = payload.data;
        } catch (err) {
          state.homeRespError = err?.message || "No se pudo cargar los responsables.";
        }
        state.homeRespLoading = false;
        repaintCostPanel();
      }

      // opts: { cachedOnly } solo lee caché (no gasta consulta); { silent } no
      // muestra spinner ni error (para el auto-chequeo al abrir); { force } recalcula.
      async function loadDailyByService(opts = {}) {
        if (!opts.silent) {
          state.homeDailyLoading = true;
          state.homeDailyError = "";
          state.homeDailyOpenDate = null;
          repaintCostPanel();
        }
        const { start, end } = periodRange(state.homeCostPeriod);
        let url = `api/home/costs/daily?account=${encodeURIComponent(state.homeCostAccount)}&start=${start}&end=${end}`;
        if (opts.cachedOnly) url += "&cachedOnly=1";
        if (opts.force) url += "&force=1";
        try {
          const payload = await apiRequest(url);
          // pending = no había caché y no se consultó AWS: dejar para el botón.
          if (!payload.data || payload.data.pending) {
            state.homeDaily = null;
          } else {
            state.homeDaily = payload.data;
          }
        } catch (err) {
          if (!opts.silent) state.homeDailyError = err?.message || "No se pudo analizar la variación diaria.";
        }
        state.homeDailyLoading = false;
        repaintCostPanel();
      }

      function clearResponsibles() {
        state.homeRespKey = null;
        state.homeResp = null;
        state.homeRespError = "";
        state.homeRespLoading = false;
      }

      function toggleDailyDay(date) {
        // Cambiar de día cierra cualquier drill de tipo de uso abierto.
        state.homeDailyOpenDate = state.homeDailyOpenDate === date ? null : date;
        state.homeDailyDetailKey = null;
        state.homeDailyDetail = null;
        state.homeDailyDetailError = "";
        clearResponsibles();
        repaintCostPanel();
      }

      async function loadDailyServiceDetail(key) {
        clearResponsibles(); // el panel de responsables corresponde al servicio abierto
        if (state.homeDailyDetailKey === key) {
          state.homeDailyDetailKey = null;
          state.homeDailyDetail = null;
          state.homeDailyDetailError = "";
          repaintCostPanel();
          return;
        }
        const [date, service] = key.split("|");
        state.homeDailyDetailKey = key;
        state.homeDailyDetail = null;
        state.homeDailyDetailError = "";
        state.homeDailyDetailLoading = true;
        repaintCostPanel();
        try {
          // Reusa el endpoint de detalle con una ventana de UN día.
          const payload = await apiRequest(`api/home/costs/detail?account=${encodeURIComponent(state.homeCostAccount)}&service=${encodeURIComponent(service)}&start=${date}&end=${dayPlusOne(date)}`);
          state.homeDailyDetail = payload.data;
        } catch (err) {
          state.homeDailyDetailError = err?.message || "No se pudo cargar el detalle del día.";
        }
        state.homeDailyDetailLoading = false;
        repaintCostPanel();
      }

      function homeDateTimeLabel(iso) {
        if (!iso) return "—";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleString("es-GT", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala" });
      }

      function homeStatCard(label, value) {
        return `<div class="homeStatCard"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
      }
      function homeCostCard(label, amount, isCredit, isNet) {
        const n = parseFloat(amount);
        const cls = isNet ? "homeStatCard homeNet" : isCredit ? "homeStatCard homeCreditCard" : "homeStatCard";
        return `<div class="${cls}"><strong>$${escapeHtml(Number.isFinite(n) ? n.toFixed(2) : amount)}</strong><span>${escapeHtml(label)}</span></div>`;
      }

      // ── Pestaña Athena: consumo por usuario (CloudTrail + Athena) ─────────────
      function athenaRange() {
        // "yesterday" = AYER completo (día cerrado: datos estables y el caché del
        // backend lo conserva con TTL largo al ser ventana ya inmutable).
        if (state.athenaRangeDays === "yesterday") {
          const y = new Date();
          y.setUTCDate(y.getUTCDate() - 1);
          const day = y.toISOString().slice(0, 10);
          return { start: day, end: day };
        }
        const end = new Date().toISOString().slice(0, 10);
        const s = new Date();
        s.setUTCDate(s.getUTCDate() - (state.athenaRangeDays - 1));
        return { start: s.toISOString().slice(0, 10), end };
      }
      function athMs(ms) {
        ms = Number(ms) || 0;
        return ms >= 60000 ? (ms / 60000).toFixed(1) + " min" : (ms / 1000).toFixed(1) + "s";
      }
      // Etiquetas de antipatrones (espejo de _ANTIPATTERNS en el backend), para
      // armar el resumen por usuario cuando solo llega el conteo por código.
      const ANTIP_LABELS = {
        select_star: "SELECT *", tabla_sin_db: "tabla sin base de datos",
        sin_where: "sin filtro WHERE", sin_particion: "sin filtro de partición",
        order_sin_limit: "ORDER BY sin LIMIT", cross_join: "CROSS JOIN / JOIN sin ON",
        like_comodin: "LIKE con comodín al inicio", union_dedup: "UNION (usa UNION ALL)",
        func_en_filtro: "función sobre columna en filtro", cast_en_filtro: "conversión de tipo en filtro",
        subquery_repetida: "subconsulta/CTE repetida", formato_no_columnar: "formato no columnar (CSV/JSON)",
        no_parse: "no se pudo analizar",
      };
      // Recomendación "cómo arreglar" por antipatrón; se despliega al presionar el badge.
      const ANTIP_RECO = {
        select_star: "Lista solo las columnas que necesitas; leer todas escanea de más.",
        tabla_sin_db: "Califica la tabla con su base (base.tabla).",
        sin_where: "Agrega un WHERE para no recorrer toda la tabla.",
        sin_particion: "Filtra por las columnas de partición (p. ej. anio/mes/dia), no por una columna normal ni dentro de una función, para que Athena pode particiones. Ojo: en tablas de ingesta la partición suele ser la fecha de arribo del archivo, no la fecha del registro — si no son lo mismo, filtrar solo por partición puede excluir datos válidos. Si conoces el rezago máximo entre ambas fechas, agrega la partición como filtro más ancho (p. ej. ±5 días) además del filtro exacto, para podar sin perder datos.",
        order_sin_limit: "Agrega LIMIT si solo exploras; ordenar todo el resultado es caro.",
        cross_join: "Agrega la condición de unión (ON) para evitar el producto cartesiano.",
        like_comodin: "Evita el comodín al inicio ('%x'); si puedes, ánclalo ('x%').",
        union_dedup: "Usa UNION ALL si no necesitas eliminar duplicados (UNION deduplica y cuesta más).",
        func_en_filtro: "Evita envolver la columna en una función dentro del WHERE (ej. date(col), UPPER(col)); compara contra el valor crudo para que el motor pueda podar datos.",
        cast_en_filtro: "Evita convertir el tipo de la columna en el WHERE (CAST); ajusta el tipo del valor comparado en vez de castear la columna.",
        subquery_repetida: "Evita repetir la misma subconsulta o referenciar una CTE varias veces; Athena no la materializa y la vuelve a calcular en cada referencia.",
        formato_no_columnar: "Esta tabla está en CSV/JSON; si puedes, migra a Parquet/ORC/Iceberg para leer solo las columnas necesarias y comprimir mejor.",
      };
      function antipTitle(counts) {
        const c = counts || {};
        const parts = Object.keys(c).map((k) => `${ANTIP_LABELS[k] || k}: ${c[k]}`);
        return parts.length ? parts.join(" · ") : "Sin antipatrones";
      }
      // Renderiza el SQL escapado, pintando en rojo los tramos marcados (rangos
      // [inicio,fin] inclusivos sobre el texto). Robusto ante marcas fuera de rango.
      function sqlHtml(sql, marks) {
        if (!sql) return "";
        const ranges = (marks || [])
          .filter((m) => Array.isArray(m) && m.length === 2 && Number.isInteger(m[0]) && m[0] < sql.length)
          .map((m) => [Math.max(0, m[0]), Math.min(sql.length - 1, m[1])])
          .filter((m) => m[1] >= m[0])
          .sort((a, b) => a[0] - b[0]);
        let out = "", i = 0;
        for (const [a, b] of ranges) {
          if (a < i) continue;                       // marca solapada: la omite
          out += escapeHtml(sql.slice(i, a));
          out += `<span class="sqlBad">${escapeHtml(sql.slice(a, b + 1))}</span>`;
          i = b + 1;
        }
        out += escapeHtml(sql.slice(i));
        return out;
      }
      // Columnas de la tabla "Por usuario" (highlight table): cada una sabe leer y
      // formatear su valor; el color tiñe la celda según su intensidad relativa.
      function athUserCols() {
        return [
          { key: "queries",      label: "Consultas",    color: "#2a78d6", get: (u) => Number(u.queries) || 0,            fmt: (v) => v.toLocaleString("en-US") },
          { key: "bytes",        label: "Escaneado",    color: "#1baf7a", get: (u) => Number(u.bytes) || 0,              fmt: (v) => formatBytes(v) },
          { key: "costo",        label: "Costo ~",      color: "#eda100", get: (u) => (Number(u.bytes) || 0) / 1e12 * 5, fmt: (v) => "$" + fmtUsd(v) },
          { key: "totalMs",      label: "Tiempo total", color: "#4a3aa7", get: (u) => Number(u.totalMs) || 0,            fmt: (v) => athMs(v) },
          { key: "maxMs",        label: "Máx",          color: "#eb6834", get: (u) => Number(u.maxMs) || 0,              fmt: (v) => athMs(v) },
          { key: "antipatterns", label: "Antipatrones", color: "#e34948", get: (u) => Number(u.antipatterns) || 0,       fmt: (v) => v.toLocaleString("en-US") },
        ];
      }
      // Tinte de fondo por celda: intensidad relativa dentro de la columna, suavizada
      // con raíz para que un outlier (p. ej. un rol de servicio) no aplane al resto.
      function athTint(color, ratio) {
        const a = ratio > 0 ? 0.07 + Math.sqrt(Math.min(ratio, 1)) * 0.5 : 0;
        if (!a) return "";
        const n = parseInt(color.slice(1), 16);
        return `background:rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
      }
      // Tarjeta de una consulta (badges de antipatrones + SQL resaltado + "ver
      // completa"). Reusada por "Consultas más pesadas" y por el drill por usuario.
      function athenaQueryCard(q, showUser) {
        const full = q.qid ? state.athenaSqlCache[q.qid] : null;
        const open = state.athenaOpenQid === q.qid;
        const sqlText = (open && full && full.sql) ? full.sql : (q.sql || "");
        const loadingFull = open && full && full.loading;
        const btn = q.qid
          ? `<button type="button" class="textButton athenaFullBtn" data-athena-qid="${escapeAttribute(q.qid)}">${open ? "Ocultar" : "Ver consulta completa"}</button>`
          : "";
        const issues = q.issues || [];
        // Cada badge tiene DOS acciones independientes: la etiqueta es un interruptor
        // (marca/desmarca ese antipatrón en el resaltado del query, encendido por
        // defecto) y el ícono ⓘ solo muestra/oculta su recomendación — un clic no
        // debe hacer ambas cosas a la vez, confunde qué controla qué.
        const badges = issues.length
          ? `<div class="antipBadges">${issues.map((it) => {
              if (!ANTIP_RECO[it.code]) return `<span class="antipBadge">${escapeHtml(it.label)}</span>`;
              const key = `${q.qid}#${it.code}`;
              const off = !!state.athenaMarkOff[key];
              const infoOpen = !!state.athenaOpenInfo[key];
              return `<span class="antipBadge antipBadgeGroup${off ? " antipBadgeOff" : ""}">`
                + `<button type="button" class="antipBadgeLabel" data-antip="${escapeAttribute(key)}" aria-pressed="${off ? "false" : "true"}" title="${off ? "Volver a marcar en el query" : "Quitar del resaltado en el query"}">${escapeHtml(it.label)}</button>`
                + `<button type="button" class="antipInfoBtn${infoOpen ? " open" : ""}" data-antip-info="${escapeAttribute(key)}" aria-expanded="${infoOpen ? "true" : "false"}" aria-label="Ver recomendación">ⓘ</button>`
                + `</span>`;
            }).join("")}</div>`
          : "";
        const openInfos = issues.filter((it) => ANTIP_RECO[it.code] && state.athenaOpenInfo[`${q.qid}#${it.code}`]);
        const recoBlock = openInfos.length
          ? `<div class="antipReco">${openInfos.map((it) => `<div class="antipRecoRow"><b>${escapeHtml(it.label)}:</b> ${escapeHtml(ANTIP_RECO[it.code])}</div>`).join("")}</div>`
          : "";
        const marksByCode = q.marksByCode || {};
        const activeMarks = issues.flatMap((it) => {
          const off = !!state.athenaMarkOff[`${q.qid}#${it.code}`];
          return off ? [] : (marksByCode[it.code] || []);
        });
        const suggestState = q.qid ? state.athenaLlmSuggest[q.qid] : null;
        // Ya generada: el mismo botón alterna mostrar/ocultar (sin volver a llamar
        // al modelo). Solo mientras carga se deshabilita para no duplicar la llamada.
        const suggestReady = suggestState && !suggestState.loading && !suggestState.error;
        const suggestVisible = !suggestState || suggestState.visible !== false;
        const suggestLabel = suggestState && suggestState.error ? "💡 Reintentar"
          : suggestReady ? (suggestVisible ? "Ocultar sugerencia" : "💡 Ver sugerencia")
          : "💡 Sugerencia";
        const suggestBtn = (issues.length && q.qid)
          ? `<button type="button" class="textButton athenaSuggestBtn" data-llm-suggest="${escapeAttribute(q.qid)}" ${suggestState && suggestState.loading ? "disabled" : ""}>${suggestLabel}</button>`
          : "";
        const suggestBlock = (!suggestState || !suggestVisible) ? "" : suggestState.loading
          ? `<div class="athenaLlmBox athenaLlmLoading">Generando sugerencia…</div>`
          : suggestState.error
          ? `<div class="athenaLlmBox athenaLlmError">${escapeHtml(suggestState.error)}</div>`
          : `<div class="athenaLlmBox"><div class="athenaLlmTitle">💡 Sugerencia</div>${mdLite(suggestState.text)}<button type="button" class="athenaCopyBtn athenaLlmCopyBtn" data-copy-llm="${escapeAttribute(q.qid)}" aria-label="Copiar sugerencia" title="Copiar sugerencia">⧉</button></div>`;
        const who = (showUser && q.user)
          ? `<span class="homeSvcName" title="${escapeAttribute(q.name ? `${q.name} · ${q.user}` : q.user)}">${escapeHtml(q.name || q.user)} <span class="homeCostAgo">· ${escapeHtml(q.wg || "")}</span></span>`
          : `<span class="homeSvcName"><span class="homeCostAgo">${escapeHtml(q.wg || "")}</span></span>`;
        return `
        <div class="athenaQueryRow">
          <div class="athenaQueryMeta">
            ${who}
            <span class="homeTopMeta">${q.count ? `×${Number(q.count).toLocaleString("en-US")} ejec. · ` : ""}${formatBytes(q.bytes)} · ${athMs(q.ms)} · $${fmtUsd((q.bytes || 0) / 1e12 * 5)}${q.lastRun ? ` · últ. ${homeDateTimeLabel(q.lastRun)} (${catalogSyncedLabel(q.lastRun)})` : ""}</span>
          </div>
          ${badges}${recoBlock}
          <div class="athenaSqlWrap">
            <pre class="athenaSql${open ? " full" : ""}" data-sql-key="${escapeAttribute(q.qid || "")}">${sqlHtml(sqlText, activeMarks)}${loadingFull ? "\n\n— cargando consulta completa… —" : (open ? "" : "…")}</pre>
            <button type="button" class="athenaCopyBtn" data-copy-sql aria-label="Copiar SQL" title="Copiar SQL">⧉</button>
          </div>
          ${suggestBlock}
          <div class="athenaQueryActions">${btn}${suggestBtn}</div>
        </div>`;
      }
      // Drill por usuario: sus consultas con antipatrones (bajo demanda, item aparte).
      function athenaUserDetail(u) {
        const ap = state.athenaUserAp[u.user];
        if (!ap || ap.loading) return `<p class="catalogEmpty">Cargando consultas con antipatrones…</p>`;
        if (ap.error) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(ap.error)}</p>`;
        const all = ap.queries || [];
        if (!all.length) return `<p class="catalogEmpty">Sin consultas con antipatrones en el rango.</p>`;
        const counts = u.issueCounts || {};
        // Filtro por antipatrón agrupado en un solo desplegable (si el código elegido
        // no aplica a este usuario, cae a "todos" para no mostrar vacío).
        const code = (state.athenaApFilter && counts[state.athenaApFilter]) ? state.athenaApFilter : "";
        const qs0 = code ? all.filter((q) => (q.issues || []).some((it) => it.code === code)) : all;
        const sortKey = state.athenaApSort || "bytes";
        const dir = state.athenaApSortDir === "asc" ? 1 : -1;
        const qs = qs0.slice().sort((a, b) => {
          if (sortKey === "lastRun") {
            const av = a.lastRun || "", bv = b.lastRun || "";
            return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
          }
          return ((Number(a[sortKey]) || 0) - (Number(b[sortKey]) || 0)) * dir;
        });
        const filterOpts = `<option value="">Todos (${all.length})</option>`
          + Object.keys(counts).map((c) =>
              `<option value="${escapeAttribute(c)}" ${code === c ? "selected" : ""}>${escapeHtml(ANTIP_LABELS[c] || c)} (${counts[c]})</option>`).join("");
        const opts = [["bytes", "Escaneado"], ["count", "Ejecuciones"], ["ms", "Tiempo"], ["lastRun", "Más reciente"]]
          .map(([k, l]) => `<option value="${k}" ${sortKey === k ? "selected" : ""}>${l}</option>`).join("");
        const dirIcon = state.athenaApSortDir === "asc" ? "↑" : "↓";
        return `<div class="athUserApHead">
            <span class="athApControls">
              <label class="athApSortLbl">Antipatrón <select id="athenaApFilterSel">${filterOpts}</select></label>
              <label class="athApSortLbl">Ordenar por <select id="athenaApSort">${opts}</select></label>
              <button type="button" class="athApDir" id="athenaApDir" title="${state.athenaApSortDir === "asc" ? "Ascendente" : "Descendente"}" aria-label="Cambiar orden ascendente/descendente">${dirIcon}</button>
              <button type="button" class="textButton athUserCsvBtn" data-ath-csv="${escapeAttribute(u.user)}">Descargar CSV</button>
            </span>
          </div>
          <p class="homeCostAgo athApShown">${qs.length} de ${all.length} patrón(es)${code ? ` · ${escapeHtml(ANTIP_LABELS[code] || code)}` : ""}</p>`
          + qs.map((q) => athenaQueryCard(q, false)).join("");
      }
      // Exporta los patrones con antipatrones del usuario (lo ya cargado en el drill) a CSV.
      function downloadAthenaUserCsv(user) {
        const ap = state.athenaUserAp[user];
        const qs = (ap && ap.queries) || [];
        const uobj = ((state.athenaData && state.athenaData.users) || []).find((x) => x.user === user);
        const name = (uobj && uobj.name) || "";
        const cell = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
        const rows = [["nombre", "usuario", "ejecuciones", "gb_escaneado_total", "costo_usd", "ultima_ejecucion", "antipatrones", "sql_ejemplo"]];
        for (const q of qs) {
          rows.push([name, user, q.count || 1, ((q.bytes || 0) / 1e9).toFixed(2),
            ((q.bytes || 0) / 1e12 * 5).toFixed(2), q.lastRun || "",
            (q.issues || []).map((i) => i.label).join(" | "),
            (q.sql || "").replace(/\s+/g, " ")]);
        }
        const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
        const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `antipatrones_${user.replace(/[^a-z0-9._@-]/gi, "_")}.csv`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      }
      function toggleAthenaUser(user) {
        if (!user) return;
        if (state.athenaOpenUser === user) { state.athenaOpenUser = null; paintHome(); return; }
        state.athenaOpenUser = user;
        const cached = state.athenaUserAp[user];
        paintHome();
        // Como solo se puede expandir a usuarios con antipatrones, un resultado en
        // caché SIN consultas es siempre obsoleto (se pidió durante el escaneo, antes
        // de que se escribiera su item) → re-pedir. (`[]` es "truthy", por eso antes
        // se quedaba pegado en vacío.)
        const stale = cached && !cached.loading && !cached.error && !(cached.queries && cached.queries.length);
        if (!cached || cached.error || stale) loadAthenaUserAp(user);
      }
      async function loadAthenaUserAp(user) {
        const { start, end } = athenaRange();
        state.athenaUserAp[user] = { loading: true };
        paintHome();
        try {
          const p = await apiRequest(`api/home/athena?apUser=${encodeURIComponent(user)}&start=${start}&end=${end}`);
          state.athenaUserAp[user] = { queries: p.data.queries || [], loading: false };
        } catch (err) {
          state.athenaUserAp[user] = { error: err?.message || "No se pudieron cargar las consultas.", loading: false };
        }
        if (state.athenaOpenUser === user) paintHome();
      }
      // Filtro de la tabla por usuario sin re-render (no pierde foco del input).
      function applyAthenaUserFilter() {
        const f = (state.athenaUserFilter || "").toLowerCase();
        for (const el of elements.contentPanel.querySelectorAll("[data-arow]")) {
          el.style.display = (!f || el.dataset.arow.includes(f)) ? "" : "none";
        }
      }
      function ensureAthena(force) {
        if (state.athenaLoading) return;
        if (force || (!state.athenaData && !state.athenaScanning)) loadAthena();
        else if (state.athenaScanning) scheduleAthenaPoll();
      }
      async function fetchAthena(forceRescan) {
        const { start, end } = athenaRange();
        const p = await apiRequest(`api/home/athena?start=${start}&end=${end}${forceRescan ? "&force=1" : ""}`);
        state.athenaData = p.data.data || null;
        state.athenaStatus = p.data.status || "empty";
        state.athenaScanning = !!p.data.scanning;
        state.athenaScannedAt = p.data.scannedAt || null;
        // Ventana nueva sin datos aún: el backend presta los de la ventana previa
        // más parecida mientras corre el primer escaneo (evita pantalla vacía).
        state.athenaProvisional = p.data.provisional || null;
      }
      async function loadAthena(forceRescan) {
        state.athenaLoading = true; state.athenaError = "";
        paintHome();
        try { await fetchAthena(forceRescan); }
        catch (err) { state.athenaError = err?.message || "No se pudo cargar el consumo de Athena."; }
        state.athenaLoading = false;
        paintHome();
        if (state.athenaScanning) scheduleAthenaPoll();
      }
      function scheduleAthenaPoll() {
        if (state.athenaPollTimer) return;
        state.athenaPollTimer = window.setTimeout(async () => {
          state.athenaPollTimer = null;
          if (state.homeTab !== "athena") return;
          try { await fetchAthena(); } catch {}
          paintHome();
          if (state.athenaScanning) scheduleAthenaPoll();
        }, 5000);
      }
      function athenaBlock() {
        const d = state.athenaData;
        const days = state.athenaRangeDays;
        const fresh = state.athenaScannedAt
          ? `Calculado: <b>${homeDateTimeLabel(state.athenaScannedAt)}</b> <span class="homeCostAgo">(${catalogSyncedLabel(state.athenaScannedAt)})</span>`
          : "";
        const scanningMsg = state.athenaScanning ? ` · <span class="ingestScanning">Calculando…</span>` : "";
        const header = `
          <div class="homeCostHeader">
            <div><p class="eyebrow">Consumo Athena · por usuario</p>
            <h2>Monitoreo de consultas <button type="button" class="athInfoBtn" id="athenaInfoBtn" title="¿Qué es esto?" aria-label="Información">ⓘ</button></h2>
            <p class="homeDailyFreshness">${fresh}${scanningMsg}</p></div>
            <div class="homeCostControls">
              <label>Rango
                <select id="athenaRangeSelect">
                  <option value="yesterday" ${days === "yesterday" ? "selected" : ""}>Ayer</option>
                  ${[7, 14, 30].map((n) => `<option value="${n}" ${days === n ? "selected" : ""}>Últimos ${n} días</option>`).join("")}
                </select>
              </label>
              <button type="button" id="athenaRefresh" class="tinyButton" title="Recalcular consumo">↻ Actualizar</button>
            </div>
          </div>`;
        const provisionalBanner = (d && state.athenaProvisional)
          ? `<p class="athenaProvisional">Mostrando datos del rango <b>${escapeHtml(state.athenaProvisional.start)} a ${escapeHtml(state.athenaProvisional.end)}</b> mientras se calcula el rango actual — se actualiza solo al terminar.</p>`
          : "";
        let inner;
        if (state.athenaError) {
          inner = `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.athenaError)}</p>`;
        } else if (!d && (state.athenaScanning || state.athenaLoading)) {
          inner = `<p class="catalogEmpty">Calculando consumo de Athena (CloudTrail + Athena)… puede tardar, se actualiza solo.</p>`;
        } else if (!d) {
          inner = `<p class="catalogEmpty">Sin datos. Presiona "Actualizar".</p>`;
        } else {
          const users = d.users || [];
          const totals = `<span class="homeTopMeta">${(d.totalQueries || 0).toLocaleString("en-US")} consultas · ${formatBytes(d.totalBytes || 0)} escaneados · ~$${fmtUsd((d.totalBytes || 0) / 1e12 * 5)} <span class="homeCostAgo">(${escapeHtml(d.start)} a ${escapeHtml(d.end)})</span></span>`;
          const cols = athUserCols().filter((c) => state.athenaCols[c.key] !== false);
          const colMax = {};
          for (const c of cols) colMax[c.key] = users.reduce((m, u) => Math.max(m, c.get(u)), 0) || 1;
          const sort = state.athenaSort || { key: "bytes", dir: -1 };
          const sortCol = cols.find((c) => c.key === sort.key);
          const sorted = users.slice().sort((a, b) => {
            if (sort.key === "user") return (a.user < b.user ? -1 : a.user > b.user ? 1 : 0) * sort.dir;
            return sortCol ? (sortCol.get(a) - sortCol.get(b)) * sort.dir : 0;
          });
          const arrow = (k) => sort.key === k ? `<span class="athSortAr">${sort.dir < 0 ? "▾" : "▴"}</span>` : "";
          const userRows = sorted.map((u) => {
            const arow = `${u.name || ""} ${u.user || ""}`.toLowerCase();   // filtro por nombre o código
            const hasAp = Number(u.antipatterns) > 0;
            const openU = state.athenaOpenUser === u.user;
            const label = escapeHtml(u.name || u.user);
            const codeTitle = escapeAttribute(u.name ? `${u.name} · ${u.user}` : u.user);
            const nameCell = hasAp
              ? `<td class="athUserCell"><button type="button" class="athUserToggle${openU ? " open" : ""}" data-athena-user="${escapeAttribute(u.user)}" title="${codeTitle} — ver consultas con antipatrones"><span class="athUserChev">▸</span>${label}</button></td>`
              : `<td class="athUserCell" title="${codeTitle}">${label}</td>`;
            const metricCells = cols.map((c) => {
              const v = c.get(u);
              const tip = c.key === "antipatterns" ? ` title="${escapeAttribute(antipTitle(u.issueCounts))}"` : "";
              return `<td class="homeDayCellNum athHeat" style="${athTint(c.color, v / colMax[c.key])}"${tip}>${c.fmt(v)}</td>`;
            }).join("");
            let row = `<tr data-arow="${escapeAttribute(arow)}">${nameCell}${metricCells}</tr>`;
            if (openU) row += `<tr class="athUserDetailTr" data-arow="${escapeAttribute(arow)}"><td colspan="${cols.length + 1}">${athenaUserDetail(u)}</td></tr>`;
            return row;
          }).join("");
          const colChips = athUserCols().map((c) => {
            const on = state.athenaCols[c.key] !== false;
            return `<button type="button" class="athColChip${on ? "" : " off"}" data-ath-col="${c.key}"><span class="athColDot" style="background:${c.color}"></span><span class="athColLab">${c.label}</span></button>`;
          }).join("");
          const userHeaders = `<th class="athSortable${sort.key === "user" ? " act" : ""}" data-ath-sort="user">Usuario ${arrow("user")}</th>`
            + cols.map((c) => `<th class="homeDayCellNum athSortable${sort.key === c.key ? " act" : ""}" data-ath-sort="${c.key}"${c.key === "antipatterns" ? ' title="Consultas con antipatrones (SELECT *, tabla sin base, sin WHERE, ORDER BY sin LIMIT)"' : ""}>${c.label} ${arrow(c.key)}</th>`).join("");
          const top = (d.topQueries || []).slice(0, 15).map((q) => athenaQueryCard(q, true)).join("");
          inner = `${totals}
            <div class="homeTopList"><h3>Por usuario</h3>
              <div class="athUserControls"><input type="search" id="athenaUserFilter" class="searchInput athUserFilter" placeholder="Filtrar usuario…" value="${escapeAttribute(state.athenaUserFilter || "")}" /></div>
              <div class="athColChips">${colChips}</div>
              <p class="homeCostAgo athUserHint">Clic en un usuario con antipatrones para ver sus consultas.</p>
              <table class="homeDailyTable athHeatTable">
                <thead><tr>${userHeaders}</tr></thead>
                <tbody>${userRows}</tbody>
              </table>
            </div>
            <div class="homeTopList"><h3>Consultas más pesadas</h3>${top || `<p class="catalogEmpty">Sin consultas.</p>`}</div>`;
        }
        const infoPanel = state.athenaInfoOpen ? athenaInfoPanel() : "";
        return `<article class="panel homePanel">${header}${infoPanel}${provisionalBanner}${inner}</article>`;
      }
      // Guía informativa del panel (se despliega con el ícono ⓘ del encabezado).
      function athenaInfoPanel() {
        const apList = Object.keys(ANTIP_RECO).map((c) =>
          `<li><b>${escapeHtml(ANTIP_LABELS[c] || c)}:</b> ${escapeHtml(ANTIP_RECO[c])}</li>`).join("");
        return `<div class="athInfo">
          <p><b>Qué mide.</b> Quién consume Athena y cuánto: cuántas consultas hace cada usuario, cuántos datos escanean, cuánto tardan y qué malas prácticas tienen sus consultas. Te ayuda a identificar a quién apoyar para optimizar. Puedes revisar hasta ~30 días atrás (elige el rango arriba a la derecha).</p>
          <p><b>Costo ~ (estimado).</b> Se calcula a precio de lista: datos escaneados ÷ 1 TB × <b>$5</b>. Es un valor bruto aproximado, útil para comparar quién/qué consume más. El costo real está en la pestaña <b>Facturación</b>.</p>
          <p><b>Antipatrones.</b> Son malas prácticas al escribir una consulta que hacen que Athena escanee de más (queda más lenta y más cara). La columna indica cuántas consultas de ese usuario tienen alguna; haz clic en un usuario para verlas con la recomendación de cómo mejorarlas.</p>
          <p><b>Qué revisamos en cada consulta y cómo mejorarla:</b></p>
          <ul class="athInfoList">${apList}</ul>
        </div>`;
      }
      function toggleAthenaQuery(qid) {
        if (!qid) return;
        if (state.athenaOpenQid === qid) { state.athenaOpenQid = null; paintHome(); return; }
        state.athenaOpenQid = qid;
        const cached = state.athenaSqlCache[qid];
        paintHome();
        if (!cached || (!cached.sql && !cached.loading)) loadAthenaSql(qid);
      }
      async function loadAthenaSql(qid) {
        state.athenaSqlCache[qid] = { loading: true };
        paintHome();
        try {
          const p = await apiRequest(`api/home/athena?qid=${encodeURIComponent(qid)}`);
          state.athenaSqlCache[qid] = { sql: p.data.sql || "", loading: false };
        } catch (err) {
          state.athenaSqlCache[qid] = { sql: "No se pudo cargar la consulta completa.", loading: false };
        }
        if (state.athenaOpenQid === qid) paintHome();
      }
      // Sugerencia del LLM para UNA consulta puntual (bajo demanda, no se precarga
      // para todas). El backend relee el SQL completo por qid y vuelve a analizarlo
      // — no manda el cliente el SQL ni los antipatrones, evita datos desalineados.
      async function loadAthenaSuggestion(qid) {
        if (!qid) return;
        const cached = state.athenaLlmSuggest[qid];
        // Con error previo NO se togglea: se limpia y se reintenta la llamada.
        if (cached && !cached.loading && !cached.error) {
          // Ya está lista: el botón es un toggle mostrar/ocultar, sin re-llamar.
          cached.visible = cached.visible === false;
          paintHome();
          return;
        }
        if (cached && cached.loading) return;
        state.athenaLlmSuggest[qid] = { loading: true, visible: true };
        paintHome();
        try {
          const p = await apiRequest("api/home/athena/suggest", {
            method: "POST",
            body: JSON.stringify({ qid }),
          });
          state.athenaLlmSuggest[qid] = { text: p.data.suggestion || "Sin sugerencia.", loading: false, visible: true };
        } catch (err) {
          // El mensaje genérico suele ser el timeout de API Gateway (30 s) en
          // consultas muy grandes: se aclara y se deja reintentar (el botón
          // vuelve a llamar porque el estado con error no bloquea el retry).
          const msg = (err?.message && !err.message.includes("No fue posible completar"))
            ? err.message
            : "La sugerencia tardó demasiado en generarse. Vuelve a intentarlo.";
          state.athenaLlmSuggest[qid] = { error: msg, loading: false, visible: true };
        }
        paintHome();
      }

      function bindHomeEvents() {
        for (const btn of elements.contentPanel.querySelectorAll("[data-home-tab]")) {
          btn.addEventListener("click", () => {
            const tab = btn.dataset.homeTab;
            if (state.homeTab === tab) return;
            state.homeTab = tab;
            // Carga costos solo al entrar a Facturación (y solo la primera vez).
            const needCosts = tab === "facturacion" && !state.homeCosts && !state.homeCostsLoading;
            if (needCosts) state.homeCostsLoading = true; // muestra "Cargando…" de inmediato
            paintHome();
            animateViewEnter();   // entrada suave SOLO en cambio de pestaña (no en sondeos)
            if (needCosts) loadHomeCosts();
            // Carga el monitoreo de cargas al entrar a Data Lake.
            if (tab === "datalake") datalakeModule.ensure();
            // Carga el consumo de Athena al entrar a su pestaña.
            if (tab === "athena") ensureAthena();
          });
        }
        const athRange = elements.contentPanel.querySelector("#athenaRangeSelect");
        if (athRange) athRange.addEventListener("change", () => {
          state.athenaRangeDays = athRange.value === "yesterday" ? "yesterday" : (Number(athRange.value) || 7);
          state.athenaData = null; state.athenaStatus = "empty";
          state.athenaUserAp = {}; state.athenaOpenUser = null;  // el drill es por ventana
          ensureAthena(true);
        });
        const athInfo = elements.contentPanel.querySelector("#athenaInfoBtn");
        if (athInfo) athInfo.addEventListener("click", () => { state.athenaInfoOpen = !state.athenaInfoOpen; paintHome(); });
        const athRefresh = elements.contentPanel.querySelector("#athenaRefresh");
        if (athRefresh) athRefresh.addEventListener("click", () => {
          if (state.athenaLoading) return;
          state.athenaUserAp = {}; state.athenaOpenUser = null;  // invalida el drill cacheado
          loadAthena(true);   // fuerza re-escaneo aunque el caché esté fresco
        });
        for (const b of elements.contentPanel.querySelectorAll("[data-athena-qid]")) {
          b.addEventListener("click", () => toggleAthenaQuery(b.dataset.athenaQid));
        }
        for (const b of elements.contentPanel.querySelectorAll("[data-llm-suggest]")) {
          b.addEventListener("click", () => loadAthenaSuggestion(b.dataset.llmSuggest));
        }
        for (const th of elements.contentPanel.querySelectorAll("[data-ath-sort]")) {
          th.addEventListener("click", () => {
            const k = th.dataset.athSort;
            const s = state.athenaSort || { key: "bytes", dir: -1 };
            state.athenaSort = s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: k === "user" ? 1 : -1 };
            paintHome();
          });
        }
        for (const ch of elements.contentPanel.querySelectorAll("[data-ath-col]")) {
          ch.addEventListener("click", () => {
            const k = ch.dataset.athCol;
            const cols = state.athenaCols || {};
            const on = cols[k] !== false;
            // No dejar la tabla sin columnas de métrica.
            if (on && Object.values(cols).filter((v) => v !== false).length <= 1) return;
            state.athenaCols = { ...cols, [k]: !on };
            if (state.athenaSort && state.athenaSort.key === k && on) state.athenaSort = { key: "user", dir: 1 };
            paintHome();
          });
        }
        for (const b of elements.contentPanel.querySelectorAll("[data-athena-user]")) {
          b.addEventListener("click", () => toggleAthenaUser(b.dataset.athenaUser));
        }
        for (const b of elements.contentPanel.querySelectorAll("[data-ath-csv]")) {
          b.addEventListener("click", () => downloadAthenaUserCsv(b.dataset.athCsv));
        }
        for (const b of elements.contentPanel.querySelectorAll("[data-antip]")) {
          b.addEventListener("click", () => {
            const k = b.dataset.antip;
            if (state.athenaMarkOff[k]) delete state.athenaMarkOff[k];
            else state.athenaMarkOff[k] = true;
            paintHome();
          });
        }
        for (const b of elements.contentPanel.querySelectorAll("[data-antip-info]")) {
          b.addEventListener("click", () => {
            const k = b.dataset.antipInfo;
            if (state.athenaOpenInfo[k]) delete state.athenaOpenInfo[k];
            else state.athenaOpenInfo[k] = true;
            paintHome();
          });
        }
        // Copiar SQL: lee el texto ya renderizado del <pre> vecino (evita lidiar con
        // comillas/saltos de línea en atributos) y da feedback visual sin re-render
        // (no pasa por paintHome, así no se pierde el scroll ni el estado de badges).
        for (const b of elements.contentPanel.querySelectorAll("[data-copy-sql]")) {
          b.addEventListener("click", async () => {
            const pre = b.parentElement && b.parentElement.querySelector(".athenaSql");
            if (!pre) return;
            const text = (pre.textContent || "").replace(/(\n\n— cargando consulta completa… —)?…?$/, "").trimEnd();
            try {
              await navigator.clipboard.writeText(text);
              window.clearTimeout(b._copyTimer);
              b.classList.add("copied");
              b.textContent = "✓";
              b._copyTimer = window.setTimeout(() => { b.classList.remove("copied"); b.textContent = "⧉"; }, 1400);
            } catch {}
          });
        }
        // Copiar sugerencia del LLM: copia el texto ORIGINAL (markdown con el bloque
        // ```sql``` intacto) desde el estado, no el HTML renderizado — así al pegarlo
        // en un editor conserva el formato. Mismo feedback sin re-render que el SQL.
        for (const b of elements.contentPanel.querySelectorAll("[data-copy-llm]")) {
          b.addEventListener("click", async () => {
            const s = state.athenaLlmSuggest[b.dataset.copyLlm];
            if (!s || !s.text) return;
            try {
              await navigator.clipboard.writeText(s.text);
              window.clearTimeout(b._copyTimer);
              b.classList.add("copied");
              b.textContent = "✓";
              b._copyTimer = window.setTimeout(() => { b.classList.remove("copied"); b.textContent = "⧉"; }, 1400);
            } catch {}
          });
        }
        const apSort = elements.contentPanel.querySelector("#athenaApSort");
        if (apSort) apSort.addEventListener("change", () => { state.athenaApSort = apSort.value; paintHome(); });
        const apDir = elements.contentPanel.querySelector("#athenaApDir");
        if (apDir) apDir.addEventListener("click", () => {
          state.athenaApSortDir = state.athenaApSortDir === "asc" ? "desc" : "asc";
          paintHome();
        });
        const apFilterSel = elements.contentPanel.querySelector("#athenaApFilterSel");
        if (apFilterSel) apFilterSel.addEventListener("change", () => { state.athenaApFilter = apFilterSel.value; paintHome(); });
        const athUserFilter = elements.contentPanel.querySelector("#athenaUserFilter");
        if (athUserFilter) {
          athUserFilter.addEventListener("input", () => {
            state.athenaUserFilter = athUserFilter.value;
            applyAthenaUserFilter();   // sin re-render → no pierde el foco
          });
          applyAthenaUserFilter();      // re-aplica el filtro persistido tras cada paint
        }
        const acct = elements.contentPanel.querySelector("#homeAccountSelect");
        if (acct) acct.addEventListener("change", () => { state.homeCostAccount = acct.value; loadHomeCosts(); });
        const per = elements.contentPanel.querySelector("#homePeriodSelect");
        if (per) per.addEventListener("change", () => {
          const [y, m] = per.value.split("-").map(Number);
          state.homeCostPeriod = { year: y, month: m };
          loadHomeCosts();
        });
        const refresh = elements.contentPanel.querySelector("#homeRefreshCosts");
        if (refresh) refresh.addEventListener("click", () => {
          if (window.confirm("Esto vuelve a consultar AWS Cost Explorer (costo mínimo por consulta). Cost Explorer solo se actualiza unas 3 veces al día, así que normalmente no es necesario. ¿Continuar?")) {
            loadHomeCosts(true);
          }
        });
        for (const btn of elements.contentPanel.querySelectorAll("[data-cost-view]")) {
          btn.addEventListener("click", () => {
            if (state.homeCostView === btn.dataset.costView) return;
            state.homeCostView = btn.dataset.costView;
            clearServiceDetail(); // el detalle abierto pierde sentido al cambiar vista
            repaintCostPanel(); // sin volver a llamar a AWS: usa los datos en memoria
          });
        }
        for (const btn of elements.contentPanel.querySelectorAll("[data-cost-detail]")) {
          btn.addEventListener("click", () => loadServiceDetail(btn.dataset.costDetail));
        }
        // Orden de la tabla de tipos de uso (detalle por servicio / por día).
        for (const th of elements.contentPanel.querySelectorAll("[data-usage-sort]")) {
          th.addEventListener("click", () => {
            const k = th.dataset.usageSort;
            if (usageSortKey === k) usageSortDir = usageSortDir === "asc" ? "desc" : "asc";
            else { usageSortKey = k; usageSortDir = "desc"; }
            repaintCostPanel();
          });
        }
        // Orden de la tabla Detalle diario (Diario / Gasto / Variación).
        for (const th of elements.contentPanel.querySelectorAll("[data-daily-sort]")) {
          th.addEventListener("click", (e) => {
            e.stopPropagation();
            const k = th.dataset.dailySort;
            if (dailySortKey === k) dailySortDir = dailySortDir === "asc" ? "desc" : "asc";
            else { dailySortKey = k; dailySortDir = "desc"; }
            repaintCostPanel();
          });
        }
        const sectionFlags = { detail: "homeDetailCollapsed", daily: "homeDailyCollapsed", credits: "homeCreditsCollapsed" };
        for (const h of elements.contentPanel.querySelectorAll("[data-section-toggle]")) {
          h.addEventListener("click", () => {
            const flag = sectionFlags[h.dataset.sectionToggle];
            if (!flag) return;
            state[flag] = !state[flag];
            repaintCostPanel();
          });
        }
        const analyze = elements.contentPanel.querySelector("#homeAnalyzeDaily");
        // Si ya hay datos cargados es "Recalcular" (fuerza); si no, primer cálculo.
        if (analyze) analyze.addEventListener("click", (e) => { e.stopPropagation(); loadDailyByService({ force: !!state.homeDaily }); });
        for (const el of elements.contentPanel.querySelectorAll("[data-daily-day]")) {
          el.addEventListener("click", () => toggleDailyDay(el.dataset.dailyDay));
        }
        for (const btn of elements.contentPanel.querySelectorAll("[data-daily-detail]")) {
          btn.addEventListener("click", (e) => { e.stopPropagation(); loadDailyServiceDetail(btn.dataset.dailyDetail); });
        }
        const respBtn = elements.contentPanel.querySelector("[data-load-responsibles]");
        if (respBtn) respBtn.addEventListener("click", (e) => { e.stopPropagation(); loadResponsibles(); });
        // Monitoreo de cargas (Data Lake): eventos delegados al sub-módulo.
        datalakeModule.bindEvents();
      }

      function destroyCostCharts() {
        for (const k of ["service", "daily"]) {
          if (state.homeCharts[k]) { try { state.homeCharts[k].destroy(); } catch {} delete state.homeCharts[k]; }
        }
      }

      async function drawHomeCharts() {
        try { await loadChartJs(); } catch { return; }
        destroyHomeCharts();
        // Los gráficos del Resumen operativo (tareas/proyectos) se eliminaron con
        // la pestaña Resumen; quedan los del Data Lake y los de costos.
        datalakeModule.drawChart();
        drawCostCharts();
      }

      async function drawCostCharts() {
        try { await loadChartJs(); } catch { return; }
        const Chart = window.Chart;
        const c = state.homeCosts;
        if (!c) return;
        const svc = state.homeCostView === "gross" ? (c.grossByService || []) : (c.byService || []);
        const svcEl = elements.contentPanel.querySelector("#homeServiceChart");
        if (svcEl && svc.length) {
          state.homeCharts.service = new Chart(svcEl, {
            type: "bar",
            data: { labels: svc.map((x) => x.service), datasets: [{ data: svc.map((x) => parseFloat(x.amount)), backgroundColor: CHART_COLORS[1] }] },
            options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } }, maintainAspectRatio: false },
          });
        }
        // En "Bruto" muestra el consumo diario (que sí varía); en "Neto" el neto
        // (que en cuentas con créditos que cubren el consumo queda en ~0).
        const dailySeries = state.homeCostView === "gross" ? (c.dailyGross || c.daily || []) : (c.daily || []);
        const dEl = elements.contentPanel.querySelector("#homeDailyChart");
        if (dEl && dailySeries.length) {
          state.homeCharts.daily = new Chart(dEl, {
            type: "line",
            data: { labels: dailySeries.map((x) => x.date.slice(8)), datasets: [{ data: dailySeries.map((x) => parseFloat(x.amount)), borderColor: CHART_COLORS[0], backgroundColor: "rgba(47,143,131,0.15)", fill: true, tension: 0.25 }] },
            options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, maintainAspectRatio: false },
          });
        }
      }

  return { render: renderHome };
}
