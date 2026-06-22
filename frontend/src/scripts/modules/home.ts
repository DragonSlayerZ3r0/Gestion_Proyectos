// @ts-nocheck
// Módulo Inicio (dashboard). Se construye con inyección de dependencias: recibe
// el estado y los helpers compartidos del shell, sin acoplarse al resto de la app.
export function createHomeModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel } = ctx;

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
      const TASK_STATUS_LABELS = { pending: "Pendiente", in_progress: "En progreso", review: "En revisión", done: "Completada", sin_estado: "Sin estado" };
      const PROJECT_STATUS_LABELS = { planned: "Planificado", active: "Activo", paused: "Pausado", closed: "Cerrado", sin_estado: "Sin estado" };
      const CHART_COLORS = ["#2f8f83", "#4f9ed8", "#e0a93b", "#9b6dd0", "#d96d6d", "#5cb85c", "#7a8a99", "#c97fb0"];

      function loadChartJs() {
        return new Promise((resolve, reject) => {
          if (window.Chart) { resolve(); return; }
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("No fue posible cargar Chart.js desde CDN."));
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
        elements.viewTitle.textContent = "Inicio";
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
      }

      async function loadHomeCosts(force) {
        state.homeCostsLoading = true;
        state.homeCostsError = "";
        state.homeCosts = null;
        clearServiceDetail();
        repaintCostPanel();
        // La lista de cuentas se carga en paralelo (no bloquea los costos).
        ensureCostAccounts();
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
        const isAdmin = (state.profile?.user?.roles || []).includes("admin");
        const s = state.homeSummary;

        const summaryBlock = state.homeSummaryError
          ? `<article class="panel"><p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeSummaryError)}</p></article>`
          : !s
          ? `<article class="panel"><p class="catalogEmpty">Cargando resumen…</p></article>`
          : `
          <article class="panel homePanel">
            <p class="eyebrow">Vista general</p>
            <h2>Resumen operativo</h2>
            <div class="homeStatsRow">
              ${homeStatCard("Proyectos", s.projects.total)}
              ${homeStatCard("Tareas", s.tasks.total)}
              ${homeStatCard("Personas", s.people.total)}
            </div>
            <div class="homeChartsRow">
              <div class="homeChartBox"><h3>Tareas por estado</h3><canvas id="homeTasksChart"></canvas></div>
              <div class="homeChartBox"><h3>Proyectos por estado</h3><canvas id="homeProjectsChart"></canvas></div>
            </div>
          </article>`;

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

        const costBlock = !isAdmin
          ? ""
          : `<article class="panel homePanel homeCostPanel" id="homeCostPanel">${costPanelInner()}</article>`;

        // Pestañas visibles según permisos. Resumen y Data Lake se controlan por
        // usuario (homeTabs de /api/me); Facturación es admin-only.
        const homeTabs = state.profile?.homeTabs;
        // Compatibilidad: si el perfil no trae homeTabs (cache previa), todas on.
        const canResumen = !homeTabs || homeTabs.includes("home_resumen");
        const canDatalake = !homeTabs || homeTabs.includes("home_datalake");
        const tabs = [];
        if (canResumen) tabs.push({ id: "resumen", label: "Resumen" });
        if (canDatalake) tabs.push({ id: "datalake", label: "Data Lake" });
        if (isAdmin) tabs.push({ id: "facturacion", label: "Facturación" });

        // Asegura que la pestaña activa exista entre las visibles.
        if (!tabs.some((t) => t.id === state.homeTab)) {
          state.homeTab = tabs.length ? tabs[0].id : "resumen";
        }
        const tab = state.homeTab;

        const tabBar = `
          <div class="homeTabs" role="tablist">
            ${tabs.map((t) => `<button type="button" class="homeTab ${tab === t.id ? "active" : ""}" data-home-tab="${t.id}">${escapeHtml(t.label)}</button>`).join("")}
          </div>`;

        let body;
        if (!tabs.length) {
          body = `<article class="panel"><p class="catalogEmpty">No tienes pestañas habilitadas en Inicio. Contacta a un administrador.</p></article>`;
        } else if (tab === "facturacion" && isAdmin) {
          body = costBlock;
        } else if (tab === "datalake") {
          body = state.homeSummaryError
            ? `<article class="panel"><p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeSummaryError)}</p></article>`
            : !s
            ? `<article class="panel"><p class="catalogEmpty">Cargando catálogo…</p></article>`
            : catalogBlock;
        } else {
          body = summaryBlock;
        }

        elements.contentPanel.innerHTML = tabBar + body;
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
            <div class="homeChartBox"><h3>Tendencia diaria (neto)</h3><canvas id="homeDailyChart"></canvas></div>
          </div>
          ${serviceDetailSection(gross ? (c.grossByService || []) : (c.byService || []))}
          ${(c.creditsByService || []).length ? `
            <div class="homeTopList">
              <h3>Créditos por servicio</h3>
              ${c.creditsByService.map((s) => `<div class="homeTopRow"><span>${escapeHtml(s.service)}</span><span class="homeTopMeta homeCredit">$${escapeHtml(s.amount)}</span></div>`).join("")}
            </div>` : ""}
        `;
      }

      // Lista de servicios con botón "Ver detalle" que expande, inline, el
      // desglose por tipo de uso (USAGE_TYPE) del servicio seleccionado.
      function serviceDetailSection(services) {
        if (!services.length) return "";
        const chevron = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"></path></svg>`;
        const rows = services.map((s) => {
          const open = state.homeCostDetailService === s.service;
          return `
            <div class="homeSvcRow">
              <div class="homeSvcMain">
                <button type="button" class="homeSvcToggle ${open ? "open" : ""}" data-cost-detail="${escapeAttribute(s.service)}"
                  aria-expanded="${open ? "true" : "false"}" aria-label="Ver detalle de uso de ${escapeAttribute(s.service)}" title="Ver detalle de uso">${chevron}</button>
                <span class="homeSvcName">${escapeHtml(s.service)}</span>
                <span class="homeTopMeta homeSvcAmount">$${escapeHtml(s.amount)}</span>
              </div>
              ${open ? `<div class="homeSvcDetail">${serviceDetailBody()}</div>` : ""}
            </div>`;
        }).join("");
        return `
          <div class="homeTopList homeSvcList">
            <h3>Detalle por servicio</h3>
            ${rows}
          </div>`;
      }

      function serviceDetailBody() {
        if (state.homeCostDetailLoading) return `<p class="catalogEmpty">Cargando detalle…</p>`;
        if (state.homeCostDetailError) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.homeCostDetailError)}</p>`;
        const d = state.homeCostDetail;
        if (!d || !d.items) return `<p class="catalogEmpty">Sin datos.</p>`;
        if (!d.items.length) return `<p class="catalogEmpty">Sin tipos de uso con costo en el periodo.</p>`;
        return `
          <table class="homeSvcTable">
            <thead><tr><th>Tipo de uso</th><th>Cantidad</th><th>Costo</th></tr></thead>
            <tbody>
              ${d.items.map((it) => `<tr>
                <td>${escapeHtml(it.usageType)}</td>
                <td class="homeSvcQty">${it.quantity ? escapeHtml(it.quantity) : "—"}</td>
                <td class="homeSvcAmt">$${escapeHtml(it.amount)}</td>
              </tr>`).join("")}
            </tbody>
          </table>`;
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

      function homeDateTimeLabel(iso) {
        if (!iso) return "—";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleString("es-GT", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      }

      function homeStatCard(label, value) {
        return `<div class="homeStatCard"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
      }
      function homeCostCard(label, amount, isCredit, isNet) {
        const n = parseFloat(amount);
        const cls = isNet ? "homeStatCard homeNet" : isCredit ? "homeStatCard homeCreditCard" : "homeStatCard";
        return `<div class="${cls}"><strong>$${escapeHtml(Number.isFinite(n) ? n.toFixed(2) : amount)}</strong><span>${escapeHtml(label)}</span></div>`;
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
            if (needCosts) loadHomeCosts();
          });
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
      }

      function destroyCostCharts() {
        for (const k of ["service", "daily"]) {
          if (state.homeCharts[k]) { try { state.homeCharts[k].destroy(); } catch {} delete state.homeCharts[k]; }
        }
      }

      async function drawHomeCharts() {
        try { await loadChartJs(); } catch { return; }
        destroyHomeCharts();
        const Chart = window.Chart;
        const s = state.homeSummary;
        if (s) {
          const tEl = elements.contentPanel.querySelector("#homeTasksChart");
          if (tEl) {
            const entries = Object.entries(s.tasks.byStatus);
            state.homeCharts.tasks = new Chart(tEl, {
              type: "doughnut",
              data: { labels: entries.map(([k]) => TASK_STATUS_LABELS[k] || k), datasets: [{ data: entries.map(([, v]) => v), backgroundColor: CHART_COLORS }] },
              options: { plugins: { legend: { position: "bottom" } }, maintainAspectRatio: false },
            });
          }
          const pEl = elements.contentPanel.querySelector("#homeProjectsChart");
          if (pEl) {
            const entries = Object.entries(s.projects.byStatus);
            state.homeCharts.projects = new Chart(pEl, {
              type: "bar",
              data: { labels: entries.map(([k]) => PROJECT_STATUS_LABELS[k] || k), datasets: [{ data: entries.map(([, v]) => v), backgroundColor: CHART_COLORS[0] }] },
              options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }, maintainAspectRatio: false },
            });
          }
        }
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
        const dEl = elements.contentPanel.querySelector("#homeDailyChart");
        if (dEl && c.daily.length) {
          state.homeCharts.daily = new Chart(dEl, {
            type: "line",
            data: { labels: c.daily.map((x) => x.date.slice(8)), datasets: [{ data: c.daily.map((x) => parseFloat(x.amount)), borderColor: CHART_COLORS[0], backgroundColor: "rgba(47,143,131,0.15)", fill: true, tension: 0.25 }] },
            options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, maintainAspectRatio: false },
          });
        }
      }

  return { render: renderHome };
}
