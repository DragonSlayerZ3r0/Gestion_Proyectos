// @ts-nocheck
// Módulo Catálogo (Data Lake) + grafo de relaciones. Inyección de dependencias.
// d3 se carga bajo demanda desde CDN y vive en window.d3 (global).
export function createCatalogModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel, catalogDateLabel } = ctx;

  // Toda llamada del módulo lleva la cuenta activa (varias cuentas de la org
  // tienen bases de datos homónimas con contenido distinto — el backend enruta
  // al Glue correcto y separa la caché/contexto por cuenta).
  const acctParam = () => `account=${encodeURIComponent(state.catalogAccount)}`;
  const withAcct = (path) => `${path}${path.includes("?") ? "&" : "?"}${acctParam()}`;
  // La caché de tablas también se separa por cuenta (la búsqueda por columnas
  // lee de aquí; sin el prefijo, mezclaría columnas de otra cuenta).
  const cacheKey = (db, table) => `${state.catalogAccount}::${db}::${table}`;

  // Normaliza para buscar: minúsculas + sin acentos (así "recuperacion" encuentra
  // "recuperación"). Se usa tanto para la consulta como para el texto indexado.
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Filtro de una tabla según la consulta (ya normalizada) y los alcances activos.
  // "Contexto" busca en TODO el contexto funcional (no solo la descripción de Glue):
  // descripción, uso principal, notas, responsable, dominio, sensibilidad y estado.
  function tableMatches(t, nq, scopes) {
    if (!nq) return true;
    const c = t.context || {};
    const ctxText = [t.description, c.description, c.usagePrimary, c.usageNotes, c.responsible, c.domain, c.sensitivity, c.status]
      .map(norm).join("  ");
    const cols = state.catalogTableCache[cacheKey(t.database, t.name)]?.columns || [];
    return (
      (scopes.includes("table")   && norm(t.name).includes(nq)) ||
      (scopes.includes("context") && ctxText.includes(nq)) ||
      (scopes.includes("column")  && cols.some(col => norm(col.name).includes(nq))) ||
      (scopes.includes("colDesc") && cols.some(col =>
        norm(col.context?.description).includes(nq) || norm(col.context?.notes).includes(nq)))
    );
  }
  // Normaliza preservando un mapeo a los índices ORIGINALES, para resaltar la
  // coincidencia en el texto real aunque el match haya sido sin acentos.
  function normMap(s) {
    let out = "", idx = [];
    for (let i = 0; i < (s || "").length; i++) {
      const n = s[i].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      for (let j = 0; j < n.length; j++) { out += n[j]; idx.push(i); }
    }
    return { out, idx };
  }
  // Devuelve el texto con la coincidencia resaltada (snippet con ventana), o null.
  function matchSnippet(text, nq) {
    if (!text || !nq) return null;
    const { out, idx } = normMap(text);
    const pos = out.indexOf(nq);
    if (pos < 0) return null;
    const start = idx[pos], end = idx[pos + nq.length - 1] + 1;
    const a = Math.max(0, start - 32), b = Math.min(text.length, end + 48);
    return (a > 0 ? "… " : "") + escapeHtml(text.slice(a, start))
      + `<mark class="catSearchHit">${escapeHtml(text.slice(start, end))}</mark>`
      + escapeHtml(text.slice(end, b)) + (b < text.length ? " …" : "");
  }
  // Dónde coincidió la búsqueda (chip de alcance + campo + snippet resaltado).
  const CTX_FIELDS = [["description","Descripción"],["usagePrimary","Uso principal"],["usageNotes","Notas"],["responsible","Responsable"],["domain","Dominio"],["sensitivity","Sensibilidad"],["status","Estado"]];
  function matchReasons(t, nq, scopes) {
    if (!nq) return [];
    const reasons = [], c = t.context || {};
    if (scopes.includes("table")) { const s = matchSnippet(t.name, nq); if (s) reasons.push(["Tabla", "", s]); }
    if (scopes.includes("context")) {
      const g = matchSnippet(t.description, nq); if (g) reasons.push(["Contexto", "Descripción (Glue)", g]);
      for (const [f, lab] of CTX_FIELDS) { const s = matchSnippet(c[f], nq); if (s) reasons.push(["Contexto", lab, s]); }
    }
    const cols = state.catalogTableCache[cacheKey(t.database, t.name)]?.columns || [];
    if (scopes.includes("column")) for (const col of cols) { const s = matchSnippet(col.name, nq); if (s) reasons.push(["Columna", col.name, s]); }
    if (scopes.includes("colDesc")) for (const col of cols) {
      const s = matchSnippet(col.context?.description, nq) || matchSnippet(col.context?.notes, nq);
      if (s) reasons.push(["Desc. columna", col.name, s]);
    }
    return reasons.slice(0, 5);
  }
  // Tarjeta de tabla en la lista de resultados (compartida por el render inicial y
  // el refinado en vivo). Si hay consulta, muestra DÓNDE coincidió, resaltado.
  function tableCardHtml(t, nq, scopes) {
    const selected = state.catalogSelectedTable && state.catalogSelectedTable.name === t.name && state.catalogSelectedTable.database === t.database;
    const reasons = nq ? matchReasons(t, nq, scopes) : [];
    const reasonsHtml = reasons.length
      ? `<span class="catMatches">${reasons.map(([sc, f, sn]) => `<span class="catMatch"><span class="catMatchScope">${sc}</span><span class="catMatchText">${f ? `<span class="catMatchField">${escapeHtml(f)}: </span>` : ""}${sn}</span></span>`).join("")}</span>`
      : "";
    return `<button class="catalogTableCard${selected ? " active" : ""}" data-db="${escapeAttribute(t.database)}" data-table="${escapeAttribute(t.name)}" type="button">
      <strong class="catalogTableName">${escapeHtml(t.name)}</strong>
      <span class="catalogTableMeta">${t.columnCount} columnas${t.tableType ? ` · ${t.tableType}` : ""}</span>
      ${(!reasons.length && t.description) ? `<span class="catalogTableDesc">${escapeHtml(t.description)}</span>` : ""}
      ${reasonsHtml}
    </button>`;
  }

      async function renderCatalog() {
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.contentPanel.className = "catalogLayout";
        elements.viewTitle.textContent = "Catálogo";

        if (!state.catalogDatabases.length) {
          state.catalogLoading = true;
          paintCatalog();
          try {
            const payload = await apiRequest(withAcct("api/catalog"));
            state.catalogDatabases = payload.data.databases || [];
            state.catalogSyncedAt = payload.data.syncedAt;
            state.catalogSyncStatus = payload.data.syncStatus;
            // Lista real de cuentas habilitadas (la manda el backend; la
            // primera es la default). El valor inicial del estado es solo
            // un arranque optimista.
            if (payload.data.accounts?.length) {
              state.catalogAccounts = payload.data.accounts;
              if (!state.catalogAccounts.some((a) => a.id === state.catalogAccount)) {
                state.catalogAccount = state.catalogAccounts[0].id;
              }
            }
            state.catalogLoading = false;
            // Si se entra con un sync en curso, sondear hasta que termine.
            if (state.catalogSyncStatus === "syncing") startCatalogSyncPolling();
            if (state.catalogDatabases.length && !state.catalogSelectedDb) {
              await selectCatalogDb(state.catalogDatabases[0].name);
              return;
            }
          } catch {
            state.catalogDatabases = [];
            state.catalogLoading = false;
          }
        }
        paintCatalog();
      }

      async function selectCatalogAccount(accountId) {
        if (accountId === state.catalogAccount) return;
        if (hasUnsavedColumnChanges() && !window.confirm("Tienes cambios de columnas sin guardar. ¿Descartarlos y cambiar de cuenta?")) {
          paintCatalog(); // restaura el valor del selector
          return;
        }
        // Cambio de cuenta = catálogo distinto: se limpia TODO el estado del
        // módulo (bases, tablas, selección, búsqueda y caché de columnas).
        state.catalogAccount = accountId;
        stopCatalogSyncPolling();
        state.catalogDatabases = [];
        state.catalogSelectedDb = null;
        state.catalogSelectedTable = null;
        state.catalogTables = [];
        state.catalogTablesLoading = false;
        state.catalogTablesError = "";
        state.catalogSearch = "";
        state.catalogSemResults = [];       // el índice semántico es por cuenta
        state.catalogSemError = "";
        state.catalogSemLoading = false;
        state.catalogSyncedAt = null;
        state.catalogSyncStatus = null;
        state.catalogTableCache = {};
        await renderCatalog();
      }

      async function selectCatalogDb(dbName) {
        state.catalogSelectedDb = dbName;
        state.catalogSelectedTable = null;
        state.catalogTables = [];
        state.catalogTablesLoading = true;
        state.catalogTablesError = "";
        state.catalogSearch = "";
        paintCatalog();
        try {
          const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(dbName)}`));
          state.catalogTables = payload.data || [];
        } catch (err) {
          state.catalogTables = [];
          state.catalogTablesError = err?.message || "No se pudieron cargar las tablas.";
        }
        state.catalogTablesLoading = false;
        paintCatalog();
      }

      // Reúne los valores ya usados en el catálogo (de la caché en memoria) para
      // sugerirlos en los datalist de dominio/sensibilidad/estado/sensibilidad-col.
      function collectCatalogContextValues() {
        const domains = new Set(), tableSens = new Set(), statuses = new Set(), colSens = new Set();
        for (const t of Object.values(state.catalogTableCache || {})) {
          const c = t.context || {};
          if (c.domain) domains.add(c.domain);
          if (c.sensitivity) tableSens.add(c.sensitivity);
          if (c.status) statuses.add(c.status);
          for (const col of (t.columns || [])) {
            const cc = col.context || {};
            if (cc.sensitivity) colSens.add(cc.sensitivity);
          }
        }
        return { domains, tableSens, statuses, colSens };
      }

      function hasUnsavedColumnChanges() {
        return [...elements.contentPanel.querySelectorAll(".catalogColumn")].some(colDiv => {
          const desc = colDiv.querySelector("[name=description]")?.value;
          const notes = colDiv.querySelector("[name=notes]")?.value;
          const sens = colDiv.querySelector("[name=sensitivity]")?.value;
          const sample = colDiv.querySelector("[name=sampleValue]")?.value;
          return desc !== (colDiv.dataset.desc || "") || notes !== (colDiv.dataset.notes || "")
            || sens !== (colDiv.dataset.sens || "") || sample !== (colDiv.dataset.sample || "");
        });
      }

      async function selectCatalogTable(dbName, tableName) {
        if (hasUnsavedColumnChanges() && !window.confirm("Tienes cambios de columnas sin guardar. ¿Descartarlos y cambiar de tabla?")) {
          return;
        }
        state.catalogSelectedTable = { name: tableName, database: dbName, loading: true, columns: [], context: {} };
        paintCatalog();
        try {
          const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(dbName)}/${encodeURIComponent(tableName)}`));
          state.catalogSelectedTable = payload.data;
          state.catalogTableCache[cacheKey(dbName, tableName)] = payload.data;
        } catch (err) {
          state.catalogSelectedTable = { name: tableName, database: dbName, error: true, errorMsg: err.message, columns: [], context: {} };
        }
        paintCatalog();
      }

      async function syncCatalogAll() {
        const btn = elements.contentPanel.querySelector(".syncAllBtn");
        if (btn) btn.disabled = true;
        try {
          await apiRequest(withAcct("api/catalog/sync"), { method: "POST" });
          state.catalogSyncStatus = "syncing";
          state.catalogDatabases = [];
          state.catalogTables = [];
          state.catalogSelectedDb = null;
          state.catalogSelectedTable = null;
          if (btn) btn.disabled = false;
          paintCatalog();
          // El sync es asíncrono en backend: sondeamos hasta que termine y
          // refrescamos solo (las bases aparecen conforme se van sincronizando).
          startCatalogSyncPolling();
        } catch (err) {
          if (btn) btn.disabled = false;
          alert(err.message || "Error al iniciar sincronización.");
        }
      }

      function stopCatalogSyncPolling() {
        if (state.catalogSyncPoller) {
          clearInterval(state.catalogSyncPoller);
          state.catalogSyncPoller = null;
        }
      }

      function startCatalogSyncPolling() {
        stopCatalogSyncPolling();
        let attempts = 0;
        const maxAttempts = 90; // ~6 min con intervalo de 4s (cubre el timeout de 300s)
        state.catalogSyncPoller = window.setInterval(async () => {
          attempts++;
          // Si el usuario salió del catálogo, dejar de sondear.
          if (state.activeModule !== "catalog") { stopCatalogSyncPolling(); return; }
          if (attempts > maxAttempts) { stopCatalogSyncPolling(); return; }
          try {
            const payload = await apiRequest(withAcct("api/catalog"));
            const dbs = payload.data.databases || [];
            const status = payload.data.syncStatus;
            const countChanged = dbs.length !== state.catalogDatabases.length;
            const statusChanged = status !== state.catalogSyncStatus;
            state.catalogDatabases = dbs;
            state.catalogSyncedAt = payload.data.syncedAt;
            state.catalogSyncStatus = status;
            if (status !== "syncing") {
              // Terminó: refrescar y auto-seleccionar la primera base.
              stopCatalogSyncPolling();
              if (dbs.length && !state.catalogSelectedDb) {
                await selectCatalogDb(dbs[0].name);
                return;
              }
              paintCatalog();
            } else if (countChanged || statusChanged) {
              // Sigue sincronizando: repintar solo si cambió algo (evita parpadeo).
              paintCatalog();
            }
          } catch { /* reintentar en el próximo tick */ }
        }, 4000);
      }

      async function syncCatalogDb(dbName) {
        const btn = elements.contentPanel.querySelector(`[data-sync-db="${CSS.escape(dbName)}"]`);
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(dbName)}/sync`), { method: "POST" });
          const idx = state.catalogDatabases.findIndex(d => d.name === dbName);
          if (idx >= 0) state.catalogDatabases[idx] = { ...state.catalogDatabases[idx], tableCount: payload.data.tableCount, syncedAt: payload.data.syncedAt };
          state.catalogTables = [];
          await selectCatalogDb(dbName);
        } catch (err) {
          if (btn) { btn.disabled = false; btn.textContent = "↻"; }
          alert(err.message || "Error al sincronizar la base de datos.");
        }
      }

      async function syncCatalogTable(dbName, tableName) {
        const btn = elements.contentPanel.querySelector(".syncTableBtn");
        if (btn) { btn.disabled = true; btn.textContent = "…"; }
        try {
          await apiRequest(withAcct(`api/catalog/${encodeURIComponent(dbName)}/${encodeURIComponent(tableName)}/sync`), { method: "POST" });
          await selectCatalogTable(dbName, tableName);
        } catch (err) {
          if (btn) { btn.disabled = false; btn.textContent = "↻"; }
          alert(err.message || "Error al actualizar la tabla.");
        }
      }

      // ── Búsqueda avanzada (semántica, toda la cuenta) ─────────────────────
      // Tarjeta de un resultado semántico: db · tabla + por qué + fragmento.
      function semResultCardHtml(r) {
        const selected = state.catalogSelectedTable
          && state.catalogSelectedTable.name === r.table && state.catalogSelectedTable.database === r.database;
        // "coincidencia" cuando además casó literal; "≈ significado" cuando solo por concepto.
        const badge = r.literal
          ? `<span class="catSemBadge lit">coincidencia</span>`
          : `<span class="catSemBadge">≈ significado</span>`;
        return `<button class="catalogTableCard catSemCard${selected ? " active" : ""}" data-db="${escapeAttribute(r.database)}" data-table="${escapeAttribute(r.table)}" type="button">
          <div class="catSemHead">
            <span class="catSemTable">${escapeHtml(r.table)}</span>
            <span class="catSemDb">${escapeHtml(r.database)}</span>
            ${badge}
          </div>
          ${r.snippet ? `<p class="catSemSnippet">${escapeHtml(r.snippet)}</p>` : ""}
        </button>`;
      }

      function semListHtml() {
        if (state.catalogSemLoading) return `<p class="catalogEmpty">Buscando por significado…</p>`;
        if (state.catalogSemError) return `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.catalogSemError)}</p>`;
        const q = (state.catalogSearch || "").trim();
        if (!q) return `<p class="catalogEmpty">Escribe una idea y presiona <b>Enter</b> (o «Buscar»): la búsqueda avanzada encuentra tablas por significado en todas las bases de la cuenta, aunque la palabra exacta no aparezca.</p>`;
        const results = state.catalogSemResults || [];
        if (!results.length) return `<p class="catalogEmpty">Sin resultados para "${escapeHtml(q)}". El diccionario semántico se llena con la descripción y columnas de cada tabla — si faltan, agrega contexto y vuelve a intentar.</p>`;
        return `<p class="catSemCount">${results.length} tabla${results.length === 1 ? "" : "s"} por relevancia (todas las bases)</p>` + results.map(semResultCardHtml).join("");
      }

      // Renderiza SOLO la lista (sin repintar todo el panel → no pierde el foco del input).
      function renderSemList() {
        const list = elements.contentPanel.querySelector(".catalogTableList");
        if (!list) return;
        list.innerHTML = semListHtml();
        list.querySelectorAll(".catSemCard").forEach(btn => {
          btn.onclick = () => openSemResult(btn.dataset.db, btn.dataset.table);
        });
      }

      async function runSemanticSearch() {
        const q = (state.catalogSearch || "").trim();
        if (!q) { state.catalogSemResults = []; state.catalogSemError = ""; renderSemList(); return; }
        state.catalogSemLoading = true; renderSemList();
        try {
          const p = await apiRequest(withAcct(`api/catalog/search?q=${encodeURIComponent(q)}`));
          state.catalogSemResults = (p.data && p.data.results) || [];
          state.catalogSemError = "";
        } catch (err) {
          state.catalogSemResults = [];
          state.catalogSemError = err?.message || "No se pudo completar la búsqueda.";
        }
        state.catalogSemLoading = false;
        renderSemList();
      }

      // Abrir un resultado: llevar a esa base + abrir la tabla, volviendo a la vista normal.
      async function openSemResult(db, table) {
        state.catalogAdvanced = false;
        if (state.catalogSelectedDb !== db) {
          await selectCatalogDb(db);          // carga las tablas de esa base y repinta
        }
        await selectCatalogTable(db, table);  // abre el detalle
      }

      function paintCatalog() {
        // Guard anti "pintar encima": el poller de sincronización sigue vivo si
        // el usuario cambia de módulo; sin esto re-renderizaría el catálogo
        // dentro de otro módulo.
        if (state.activeModule !== "catalog") return;
        const { catalogDatabases, catalogSelectedDb, catalogTables, catalogSelectedTable, catalogSearch, catalogSearchScope, catalogLoading } = state;
        const syncedAt = state.catalogSyncedAt;
        const syncStatus = state.catalogSyncStatus;

        const noCache = !catalogLoading && !catalogDatabases.length;

        const q = norm(catalogSearch);
        const scopes = catalogSearchScope; // array
        const filteredTables = catalogTables.filter(t => tableMatches(t, q, scopes));

        const dbListHtml = catalogLoading
          ? `<p class="catalogEmpty">Cargando…</p>`
          : noCache
          ? `<p class="catalogEmpty">Sin datos. Sincroniza para importar desde Glue.</p>`
          : catalogDatabases.map(db => {
              const dbFichaItems = [];
              if (db.location) dbFichaItems.push(`<span class="catalogFichaFullRow"><b>Ruta:</b> <code class="catalogLocationCode">${escapeHtml(db.location)}</code></span>`);
              if (db.description) dbFichaItems.push(`<span class="catalogFichaFullRow"><b>Descripción:</b> ${escapeHtml(db.description)}</span>`);
              dbFichaItems.push(`<span><b>Tablas:</b> ${db.tableCount || 0}</span>`);
              if (db.syncedAt) dbFichaItems.push(`<span><b>Último sync:</b> ${catalogSyncedLabel(db.syncedAt)}</span>`);
              dbFichaItems.push(`<span class="catalogDbFichaStats" data-db="${escapeAttribute(db.name)}"><b>Tamaño total:</b> <span class="catalogDbFichaStatsValue">—</span></span>`);
              return `
              <div class="catalogDbRow${db.name === catalogSelectedDb ? " active" : ""}">
                <div class="catalogDbItemWrap">
                  <button class="catalogDbItem" data-db="${escapeAttribute(db.name)}" type="button">
                    <span class="catalogDbName">${escapeHtml(db.name)}</span>
                    <span class="catalogDbMeta">${db.tableCount || 0} tablas · ${db.syncedAt ? catalogSyncedLabel(db.syncedAt) : "sin sync"}</span>
                  </button>
                  <button class="catalogSyncDbBtn iconTinyButton" type="button" data-sync-db="${escapeAttribute(db.name)}" title="Actualizar ${escapeAttribute(db.name)}">↻</button>
                </div>
                <details class="catalogDbFichaWrap">
                  <summary>Ficha técnica</summary>
                  <div class="catalogFicha">${dbFichaItems.join("")}</div>
                </details>
              </div>`;
            }).join("");

        const syncBadge = (syncStatus === "syncing")
          ? `<span class="catalogSyncBadge syncing">Sincronizando… ${catalogDatabases.length ? `${catalogDatabases.length} base${catalogDatabases.length === 1 ? "" : "s"} hasta ahora` : "esto puede tardar"}</span>`
          : syncedAt
          ? `<span class="catalogSyncBadge">Última sync: ${catalogSyncedLabel(syncedAt)}</span>`
          : `<span class="catalogSyncBadge none">Sin sincronizar</span>`;

        const tableListHtml = noCache
          ? `<div class="catalogNoCacheMsg"><p>El catálogo no tiene datos aún.</p><p>Usa el botón de sincronización para importar todas las bases de datos y tablas desde AWS Glue.</p></div>`
          : state.catalogAdvanced
          ? semListHtml()
          : !catalogSelectedDb
          ? `<p class="catalogEmpty">Selecciona una base de datos.</p>`
          : state.catalogTablesLoading
          ? `<p class="catalogEmpty">Cargando tablas…</p>`
          : state.catalogTablesError
          ? `<p class="catalogEmpty catalogEmptyError">No se pudieron cargar las tablas de esta base. Puede que no tengas acceso o que el catálogo no esté sincronizado.</p>`
          : !catalogTables.length
          ? `<p class="catalogEmpty">Esta base de datos no tiene tablas accesibles.</p>`
          : !filteredTables.length
          ? `<p class="catalogEmpty">Sin resultados para "${escapeHtml(catalogSearch)}".</p>`
          : filteredTables.map(t => tableCardHtml(t, q, scopes)).join("");

        const detailHtml = renderCatalogDetail(catalogSelectedTable);

        // Conserva el scroll de la lista de tablas y del sidebar de bases entre
        // repintados (paintCatalog reconstruye el panel y reiniciaría el scroll)
        const prevTableScroll = elements.contentPanel.querySelector(".catalogTableList")?.scrollTop || 0;
        const prevSidebarScroll = elements.contentPanel.querySelector(".catalogSidebar")?.scrollTop || 0;

        // Selector de cuenta AWS (varias cuentas replican el hub con bases
        // homónimas). La lista viene del backend; antes de la primera respuesta
        // se muestra solo la cuenta activa.
        const accountOptions = (state.catalogAccounts?.length
          ? state.catalogAccounts
          : [{ id: state.catalogAccount, name: state.catalogAccount }]);
        const accountSelectHtml = `
          <label class="catalogAccountWrap">
            <span class="catalogAccountLabel">Cuenta</span>
            <select class="catalogAccountSelect" title="Cuenta AWS del catálogo">
              ${accountOptions.map((a) => `<option value="${escapeAttribute(a.id)}" ${a.id === state.catalogAccount ? "selected" : ""}>${escapeHtml(a.name || a.id)}</option>`).join("")}
            </select>
          </label>`;

        elements.contentPanel.innerHTML = `
          <div class="catalogSidebar">
            <div class="catalogSidebarHeader">
              <p class="eyebrow">Bases de datos</p>
              <button class="syncAllBtn iconTinyButton" type="button" title="Sincronizar todo desde AWS Glue">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                  <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                </svg>
              </button>
            </div>
            ${accountSelectHtml}
            ${syncBadge}
            <nav class="catalogDbList">${dbListHtml}</nav>
          </div>
          <div class="catalogMain">
            <div class="catalogMainHeader">
              <div class="catalogMainHeaderTop">
                <p class="eyebrow">${catalogSelectedDb ? escapeHtml(catalogSelectedDb) : "Tablas"}</p>
                ${!noCache ? `
                <button class="catalogReportBtn iconTinyButton" type="button" title="Descargar reporte CSV (tablas y contexto de esta base de datos)" aria-label="Descargar reporte CSV de la base de datos">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
                    <path d="M14 3v5h5"/><path d="M12 11.5v5"/><path d="M9.5 14l2.5 2.5 2.5-2.5"/>
                  </svg>
                </button>
                <button class="catalogGraphBtn iconTinyButton" type="button" title="Ver grafo de relaciones entre tablas">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
                    <line x1="7.2" y1="6" x2="16.8" y2="6"/><line x1="5.8" y1="8" x2="11" y2="16"/><line x1="18.2" y1="8" x2="13" y2="16"/>
                  </svg>
                </button>` : ""}
              </div>
              ${!noCache ? `
              <div class="catalogSearchBar">
                <div class="catalogSearchRow">
                  <input class="searchInput catalogSearchInput" type="search" placeholder="${state.catalogAdvanced ? "Escribe una idea y presiona Enter…" : "Buscar…"}" value="${escapeAttribute(catalogSearch)}" />
                  ${state.catalogAdvanced ? `<button class="catalogSemGoBtn" type="button" title="Buscar por significado (Enter)"><span aria-hidden="true">≈</span> Buscar</button>` : ""}
                  <button class="catalogAdvancedToggle${state.catalogAdvanced ? " active" : ""}" type="button" title="Búsqueda avanzada: por significado, en TODAS las bases de la cuenta (encuentra aunque la palabra no sea exacta)"><span aria-hidden="true">≈</span> Avanzada</button>
                </div>
                ${state.catalogAdvanced
                  ? `<p class="catalogAdvancedHint">Escribe tu idea <b>completa</b> y presiona <b>Enter</b> (o «Buscar»): busca por <b>significado</b> en todo el catálogo de la cuenta. Ej.: «fecha de corte» encuentra tablas que hablan de «cutoff».</p>`
                  : `<div class="catalogScopeChips">
                  ${[
                    { key: "table",   label: "Tabla" },
                    { key: "context", label: "Contexto" },
                    { key: "column",  label: "Columna" },
                    { key: "colDesc", label: "Desc. columna" },
                  ].map(s => `<button class="catalogScopeChip${catalogSearchScope.includes(s.key) ? " active" : ""}" data-scope="${s.key}" type="button">${s.label}</button>`).join("")}
                </div>`}
              </div>` : ""}
            </div>
            <div class="catalogTableList">${tableListHtml}</div>
          </div>
          <div class="catalogDetail">${detailHtml}</div>
        `;

        // Restaura el scroll de la lista de tablas (el detalle arranca arriba).
        // Se hace tras el reflow (rAF) porque justo después de innerHTML el
        // contenido aún no tiene altura y scrollTop se quedaría en 0.
        const tableListEl = elements.contentPanel.querySelector(".catalogTableList");
        if (tableListEl && prevTableScroll > 0) {
          tableListEl.scrollTop = prevTableScroll;
          requestAnimationFrame(() => { tableListEl.scrollTop = prevTableScroll; });
        }
        const sidebarEl = elements.contentPanel.querySelector(".catalogSidebar");
        if (sidebarEl && prevSidebarScroll > 0) {
          sidebarEl.scrollTop = prevSidebarScroll;
          requestAnimationFrame(() => { sidebarEl.scrollTop = prevSidebarScroll; });
        }

        bindCatalogEvents();
      }

      function renderCatalogDetail(table) {
        if (!table) {
          return `<div class="catalogDetailEmpty"><p>Selecciona una tabla para ver sus columnas y agregar contexto.</p></div>`;
        }
        if (table.loading) {
          return `<div class="catalogDetailEmpty"><p>Cargando ${escapeHtml(table.name)}…</p></div>`;
        }
        if (table.error) {
          return `<div class="catalogDetailEmpty">
            <p>${escapeHtml(table.errorMsg || "No fue posible cargar la tabla.")}</p>
            <button class="tinyButton syncTableBtn" type="button" data-db="${escapeAttribute(table.database)}" data-table="${escapeAttribute(table.name)}">↻ Actualizar tabla desde Glue</button>
          </div>`;
        }

        const ctx = table.context || {};

        // Valores recomendados (solo sugerencias) + los que ya existen guardados
        // en el catálogo, combinados en un <datalist>. El campo es texto libre:
        // se puede tomar una sugerencia o escribir un valor nuevo.
        const used = collectCatalogContextValues();
        const domainRec = ["Comercial", "Riesgo", "Finanzas", "Operaciones", "Canales", "Clientes", "Datos / TI"];
        const sensRec = ["Interna", "Confidencial", "PII", "Financiera", "Restringida"];
        const statusRec = ["Borrador", "Pendiente revisión", "Aprobado"];
        const buildDatalist = (id, recommended, existing) => {
          const seen = new Set(recommended.map(s => s.toLowerCase()));
          const extras = [...existing].filter(v => v && !seen.has(v.toLowerCase()));
          return `<datalist id="${id}">${[...recommended, ...extras].map(v => `<option value="${escapeAttribute(v)}"></option>`).join("")}</datalist>`;
        };
        const datalists =
          buildDatalist("dlTableDomain", domainRec, used.domains) +
          buildDatalist("dlTableSens", sensRec, used.tableSens) +
          buildDatalist("dlTableStatus", statusRec, used.statuses) +
          buildDatalist("dlColSens", sensRec, used.colSens);

        // Una sensibilidad cuenta como "sensible" si no está vacía y no es interna
        const isSensitive = (v) => { const s = (v || "").trim().toLowerCase(); return !!s && s !== "interna" && s !== "interno"; };

        const isKey = (name) => name === "id" || name.endsWith("_id");
        const columnsHtml = (table.columns || []).map(col => {
          const colCtx = col.context || {};
          const documented = !!colCtx.description;
          const sensitive = isSensitive(colCtx.sensitivity || ctx.sensitivity);
          return `
            <div class="catalogColumn" data-column="${escapeAttribute(col.name)}"
                 data-desc="${escapeAttribute(colCtx.description || "")}" data-notes="${escapeAttribute(colCtx.notes || "")}"
                 data-sens="${escapeAttribute(colCtx.sensitivity || "")}" data-sample="${escapeAttribute(colCtx.sampleValue || "")}"
                 data-documented="${documented ? "1" : "0"}" data-sensitive="${sensitive ? "1" : "0"}" data-key="${isKey(col.name) ? "1" : "0"}">
              <div class="catalogColumnHeader">
                <strong>${escapeHtml(col.name)}</strong>
                <code class="catalogColumnType">${escapeHtml(col.type)}</code>
                ${col.isPartition ? `<span class="catalogPartitionBadge">partición</span>` : ""}
                ${isKey(col.name) ? `<span class="catalogKeyBadge">llave</span>` : ""}
                <span class="catalogColDirtyDot" title="Cambios sin guardar" hidden>●</span>
              </div>
              ${col.comment ? `<p class="catalogColumnComment">${escapeHtml(col.comment)}</p>` : ""}
              <div class="catalogColumnCtx${documented || colCtx.notes ? " hasCtx" : ""}">
                <textarea class="catalogColumnDesc" name="description" placeholder="Descripción funcional…" rows="2">${escapeHtml(colCtx.description || "")}</textarea>
                <div class="catalogColumnRow">
                  <input class="catalogColumnSens" name="sensitivity" list="dlColSens" placeholder="Sensibilidad (hereda)" value="${escapeAttribute(colCtx.sensitivity || "")}" />
                  <input class="catalogColumnSample" name="sampleValue" type="text" placeholder="Ejemplo de valor" value="${escapeAttribute(colCtx.sampleValue || "")}" />
                </div>
                <textarea class="catalogColumnNotes" name="notes" placeholder="Notas internas / reglas…" rows="1">${escapeHtml(colCtx.notes || "")}</textarea>
              </div>
            </div>
          `;
        }).join("");

        const cols = table.columns || [];
        const documentedCount = cols.filter(c => c.context?.description).length;

        // Ficha técnica (metadata automática de Glue + tamaño/frescura de S3)
        const fichaItems = [];
        if (table.format) fichaItems.push(`<span><b>Formato:</b> ${escapeHtml(table.format)}</span>`);
        if ((table.partitionKeys || []).length) fichaItems.push(`<span><b>Particionada por:</b> ${escapeHtml(table.partitionKeys.join(", "))}</span>`);
        fichaItems.push(`<span><b>Columnas:</b> ${cols.length}</span>`);
        if (table.glueCreatedAt) fichaItems.push(`<span><b>Creada:</b> ${catalogDateLabel(table.glueCreatedAt)}</span>`);
        if (table.glueUpdatedAt) fichaItems.push(`<span><b>Actualizada (esquema):</b> ${catalogDateLabel(table.glueUpdatedAt)}</span>`);
        if (table.location) fichaItems.push(`<span class="catalogFichaFullRow"><b>Ruta S3:</b> <code class="catalogLocationCode">${escapeHtml(table.location)}</code></span>`);
        if (table.syncedAt) fichaItems.push(`<span><b>Último sync:</b> ${catalogSyncedLabel(table.syncedAt)}</span>`);
        // El tamaño/archivos/frescura se rellena bajo demanda (lazy) desde S3
        fichaItems.push(`<span class="catalogFichaStats" data-db="${escapeAttribute(table.database)}" data-table="${escapeAttribute(table.name)}"><b>Tamaño:</b> <span class="catalogFichaStatsValue">calculando…</span></span>`);

        return `
          <div class="catalogDetailHeader">
            <div class="catalogDetailHeaderTop">
              <div>
                <p class="eyebrow">${escapeHtml(table.database)}</p>
                <h3>${escapeHtml(table.name)}</h3>
                ${table.tableType ? `<p class="catalogTableTypeLine">${escapeHtml(table.tableType)}</p>` : ""}
                <details class="catalogFichaWrap">
                  <summary>Ficha técnica</summary>
                  <div class="catalogFicha">${fichaItems.join("")}</div>
                </details>
                <details class="catalogFichaWrap catalogUsageWrap" data-usage-db="${escapeAttribute(table.database)}" data-usage-table="${escapeAttribute(table.name)}">
                  <summary>Uso reciente</summary>
                  <div class="catalogUsageBody"><p class="catalogUsageNote">Cargando…</p></div>
                </details>
              </div>
              <button class="iconTinyButton syncTableBtn" type="button" data-db="${escapeAttribute(table.database)}" data-table="${escapeAttribute(table.name)}" title="Actualizar tabla desde Glue" aria-label="Actualizar tabla desde Glue">↻</button>
            </div>
          </div>
          <div class="catalogTableCtxForm">
            <p class="catalogSectionLabel">Contexto de tabla</p>
            <textarea class="catalogCtxInput" name="tableDescription" placeholder="Descripción funcional: qué representa la tabla…" rows="2">${escapeHtml(ctx.description || "")}</textarea>
            <textarea class="catalogCtxInput" name="tableUsagePrimary" placeholder="Uso principal: ¿para qué se usa? (ej. analizar mora a 90 días por cosecha)" rows="2">${escapeHtml(ctx.usagePrimary || "")}</textarea>
            <div class="catalogCtxRow">
              <input class="catalogCtxInput" name="tableResponsible" type="text" placeholder="Responsable funcional" value="${escapeAttribute(ctx.responsible || "")}" />
              <input class="catalogCtxInput" name="tableDomain" list="dlTableDomain" placeholder="Dominio" value="${escapeAttribute(ctx.domain || "")}" />
            </div>
            <div class="catalogCtxRow">
              <input class="catalogCtxInput" name="tableSensitivity" list="dlTableSens" placeholder="Sensibilidad" value="${escapeAttribute(ctx.sensitivity || "")}" />
              <input class="catalogCtxInput" name="tableStatus" list="dlTableStatus" placeholder="Estado (borrador/aprobado)" value="${escapeAttribute(ctx.status || "")}" />
            </div>
            <textarea class="catalogCtxInput" name="tableUsageNotes" placeholder="Reglas de uso / limitaciones…" rows="2">${escapeHtml(ctx.usageNotes || "")}</textarea>
            <button class="tinyButton saveTableCtxBtn" type="button" data-db="${escapeAttribute(table.database)}" data-table="${escapeAttribute(table.name)}">Guardar contexto</button>
            <span class="catalogTableSaveNotice" hidden></span>
          </div>
          ${datalists}
          <div class="catalogColumnSection">
            <div class="catalogColumnSectionHead">
              <p class="catalogSectionLabel">${cols.length} columnas</p>
              <span class="catalogColProgress">${documentedCount} de ${cols.length} documentadas</span>
            </div>
            <div class="catalogColProgressBar"><span style="width:${cols.length ? Math.round(documentedCount / cols.length * 100) : 0}%"></span></div>
            <div class="catalogColFilters" role="group" aria-label="Filtrar columnas">
              <button class="catalogColFilterChip active" type="button" data-col-filter="all">Todas</button>
              <button class="catalogColFilterChip" type="button" data-col-filter="undocumented">Sin descripción</button>
              <button class="catalogColFilterChip" type="button" data-col-filter="sensitive">Sensibles</button>
              <button class="catalogColFilterChip" type="button" data-col-filter="key">Llaves</button>
            </div>
            <div class="catalogColumnList">${columnsHtml}</div>
          </div>
          <div class="catalogColSaveBar" data-db="${escapeAttribute(table.database)}" data-table="${escapeAttribute(table.name)}" hidden>
            <span class="catalogColSaveBarMsg"></span>
            <button class="primaryButton saveAllColsBtn" type="button" disabled>Guardar cambios</button>
          </div>
        `;
      }

      async function loadCatalogFichaStats(panel) {
        const el = panel.querySelector(".catalogFichaStats");
        if (!el) return;
        const valueEl = el.querySelector(".catalogFichaStatsValue");
        const { db, table } = el.dataset;
        try {
          const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(db)}/${encodeURIComponent(table)}?stats=1`));
          const s = payload.data?.stats;
          if (!s || !s.available) {
            valueEl.textContent = s?.reason || "no disponible";
            valueEl.classList.add("muted");
            return;
          }
          const parts = [`${formatBytes(s.sizeBytes)}`, `${s.objectCount} archivo${s.objectCount === 1 ? "" : "s"}`];
          if (s.truncated) parts[0] = "≥ " + parts[0];
          let html = `${parts.join(" · ")}`;
          if (s.lastModified) html += ` · <b>Datos hasta:</b> ${catalogDateLabel(s.lastModified)}`;
          valueEl.innerHTML = html;
        } catch {
          valueEl.textContent = "no disponible";
          valueEl.classList.add("muted");
        }
      }

      async function loadCatalogDbFichaStats(dbName: string, container: Element) {
        const el = container.querySelector(".catalogDbFichaStats");
        if (!el) return;
        const valueEl = el.querySelector(".catalogDbFichaStatsValue");
        if (!valueEl || valueEl.textContent !== "—") return; // ya cargado
        valueEl.textContent = "calculando…";
        try {
          const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(dbName)}?stats=1`));
          const s = payload.data?.stats;
          if (!s || !s.available) {
            valueEl.textContent = s?.reason || "no disponible";
            valueEl.classList.add("muted");
            return;
          }
          const parts = [`${formatBytes(s.sizeBytes)}`, `${s.objectCount} archivo${s.objectCount === 1 ? "" : "s"}`];
          if (s.truncated) parts[0] = "≥ " + parts[0];
          let html = parts.join(" · ");
          if (s.lastModified) html += ` · <b>Datos hasta:</b> ${catalogDateLabel(s.lastModified)}`;
          valueEl.innerHTML = html;
        } catch {
          valueEl.textContent = "no disponible";
          valueEl.classList.add("muted");
        }
      }

      function bindCatalogEvents() {
        const panel = elements.contentPanel;

        panel.querySelector(".syncAllBtn")?.addEventListener("click", syncCatalogAll);
        const accountSelect = panel.querySelector(".catalogAccountSelect");
        if (accountSelect) accountSelect.addEventListener("change", () => selectCatalogAccount(accountSelect.value));
        panel.querySelector(".catalogGraphBtn")?.addEventListener("click", openCatalogGraph);
        panel.querySelector(".catalogReportBtn")?.addEventListener("click", downloadCatalogReport);

        // Carga perezosa del tamaño/archivos/frescura (S3) para no demorar la
        // apertura del detalle ni las precargas masivas.
        loadCatalogFichaStats(panel);

        // Carga perezosa de stats de BD al abrir su ficha técnica
        panel.querySelectorAll(".catalogDbFichaWrap").forEach(details => {
          details.addEventListener("toggle", () => {
            if ((details as HTMLDetailsElement).open) {
              const dbName = (details.closest(".catalogDbRow") as HTMLElement)?.querySelector<HTMLElement>(".catalogDbItem")?.dataset.db || "";
              loadCatalogDbFichaStats(dbName, details);
            }
          });
        });

        panel.querySelectorAll(".catalogDbItem").forEach(btn => {
          btn.onclick = () => selectCatalogDb(btn.dataset.db);
        });

        panel.querySelectorAll(".catalogSyncDbBtn").forEach(btn => {
          btn.onclick = (e) => { e.stopPropagation(); syncCatalogDb(btn.dataset.syncDb); };
        });

        panel.querySelectorAll(".syncTableBtn").forEach(btn => {
          btn.onclick = () => syncCatalogTable(btn.dataset.db, btn.dataset.table);
        });

        // Uso reciente: quién consultó la tabla en Athena (índice que deja el
        // escaneo del monitoreo). Carga LAZY al expandir la sección.
        panel.querySelectorAll(".catalogUsageWrap").forEach(det => {
          det.addEventListener("toggle", async () => {
            if (!det.open || det.dataset.usageLoaded) return;
            det.dataset.usageLoaded = "1";
            const body = det.querySelector(".catalogUsageBody");
            try {
              const p = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(det.dataset.usageDb)}/${encodeURIComponent(det.dataset.usageTable)}/usage`));
              const d = p.data || {};
              const rows = d.users || [];
              if (!rows.length) {
                body.innerHTML = `<p class="catalogUsageNote">Sin consultas registradas en la última ventana escaneada del monitoreo de Athena.</p>`;
                return;
              }
              const fmtDT = (iso) => {
                const dd = new Date(iso);
                return isNaN(dd.getTime()) ? "—" : dd.toLocaleString("es-GT", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala" });
              };
              body.innerHTML = `
                <table class="catalogUsageTable">
                  <thead><tr><th>Usuario</th><th class="num">Consultas</th><th>Última consulta</th></tr></thead>
                  <tbody>${rows.map((u) => `
                    <tr>
                      <td title="${escapeAttribute(u.user)}">${escapeHtml(u.name || u.user)}</td>
                      <td class="num">${Number(u.count).toLocaleString("en-US")}</td>
                      <td>${escapeHtml(fmtDT(u.lastRun))} <span class="catalogUsageAgo">(${escapeHtml(catalogSyncedLabel(u.lastRun))})</span></td>
                    </tr>`).join("")}
                  </tbody>
                </table>
                <p class="catalogUsageNote">Ventana ${escapeHtml(d.start)} → ${escapeHtml(d.end)} · calculado ${escapeHtml(catalogSyncedLabel(d.scannedAt))}. Se actualiza con el escaneo del Panel · Athena.</p>`;
            } catch (err) {
              body.innerHTML = `<p class="catalogUsageNote">${escapeHtml(err?.message || "No se pudo cargar el uso reciente.")}</p>`;
            }
          });
        });

        panel.querySelectorAll(".catalogTableCard").forEach(btn => {
          btn.onclick = () => selectCatalogTable(btn.dataset.db, btn.dataset.table);
        });
        // Resultados semánticos: navegan a la base+tabla (sobrescribe el binding
        // genérico de arriba porque comparten la clase .catalogTableCard).
        panel.querySelectorAll(".catSemCard").forEach(btn => {
          btn.onclick = () => openSemResult(btn.dataset.db, btn.dataset.table);
        });

        // Toggle de búsqueda avanzada (semántica, toda la cuenta).
        panel.querySelector(".catalogAdvancedToggle")?.addEventListener("click", () => {
          state.catalogAdvanced = !state.catalogAdvanced;
          state.catalogSemError = "";
          paintCatalog();
          if (state.catalogAdvanced && (state.catalogSearch || "").trim()) runSemanticSearch();
        });

        const searchInput = panel.querySelector(".catalogSearchInput");
        if (searchInput) {
          const applySearch = () => {
            const q = norm(state.catalogSearch);
            const scopes = state.catalogSearchScope;
            const tables = state.catalogTables.filter(t => tableMatches(t, q, scopes));
            // Buscar por columna requiere el detalle de todas las tablas: se
            // precargan en segundo plano y la lista se refina conforme llegan
            const needsCols = q && (scopes.includes("column") || scopes.includes("colDesc"));
            if (needsCols && !state.catalogColsPreloading) {
              const missing = state.catalogTables.some(t => !state.catalogTableCache[cacheKey(t.database, t.name)]);
              if (missing) {
                state.catalogColsPreloading = true;
                ensureCatalogTableDetails(state.catalogTables, () => applySearch())
                  .finally(() => { state.catalogColsPreloading = false; applySearch(); });
              }
            }
            const loadingNote = needsCols && state.catalogColsPreloading
              ? `<p class="catalogEmpty">Cargando columnas de todas las tablas…</p>`
              : "";

            panel.querySelector(".catalogTableList").innerHTML = loadingNote + (tables.length
              ? tables.map(t => tableCardHtml(t, q, scopes)).join("")
              : (state.catalogColsPreloading && needsCols ? "" : `<p class="catalogEmpty">Sin resultados para "${escapeHtml(state.catalogSearch)}".</p>`));
            panel.querySelectorAll(".catalogTableCard").forEach(btn => {
              btn.onclick = () => selectCatalogTable(btn.dataset.db, btn.dataset.table);
            });
          };

          searchInput.oninput = (e) => {
            state.catalogSearch = e.target.value;
            if (state.catalogAdvanced) {
              // Semántica = por ENVÍO explícito (Enter/botón): se escribe la idea
              // completa y luego se busca. Buscar en cada tecla, con frases a
              // medias, hacía saltar resultados irrelevantes y confundía. Al
              // vaciar el campo se limpian los resultados.
              if (!(state.catalogSearch || "").trim()) { state.catalogSemResults = []; state.catalogSemError = ""; renderSemList(); }
            } else {
              applySearch();          // keyword: filtra en vivo (cada letra acota)
            }
          };
          // Enter dispara la búsqueda semántica (en el input de tipo search, el
          // botón "Buscar/Ir" del teclado móvil también cae aquí).
          searchInput.onkeydown = (e) => {
            if (e.key === "Enter" && state.catalogAdvanced) { e.preventDefault(); runSemanticSearch(); }
          };
          panel.querySelector(".catalogSemGoBtn")?.addEventListener("click", runSemanticSearch);

          panel.querySelectorAll(".catalogScopeChip").forEach(chip => {
            chip.onclick = () => {
              const scope = chip.dataset.scope;
              const active = state.catalogSearchScope;
              const isActive = active.includes(scope);
              if (isActive && active.length === 1) return; // mínimo 1 activo
              state.catalogSearchScope = isActive
                ? active.filter(s => s !== scope)
                : [...active, scope];
              panel.querySelectorAll(".catalogScopeChip").forEach(c =>
                c.classList.toggle("active", state.catalogSearchScope.includes(c.dataset.scope))
              );
              applySearch();
            };
          });
        }

        panel.querySelectorAll(".saveTableCtxBtn").forEach(btn => {
          btn.onclick = async () => {
            const { db, table } = btn.dataset;
            const form = btn.closest(".catalogTableCtxForm");
            const notice = form.querySelector(".catalogTableSaveNotice");
            const body = {
              description: form.querySelector("[name=tableDescription]").value,
              usagePrimary: form.querySelector("[name=tableUsagePrimary]").value,
              responsible: form.querySelector("[name=tableResponsible]").value,
              domain: form.querySelector("[name=tableDomain]").value,
              sensitivity: form.querySelector("[name=tableSensitivity]").value,
              status: form.querySelector("[name=tableStatus]").value,
              usageNotes: form.querySelector("[name=tableUsageNotes]").value,
            };
            btn.disabled = true;
            try {
              await apiRequest(withAcct(`api/catalog/${encodeURIComponent(db)}/${encodeURIComponent(table)}/context`), {
                method: "PUT",
                body: JSON.stringify(body),
              });
              if (state.catalogSelectedTable) state.catalogSelectedTable.context = body;
              // Refleja el contexto recién guardado en la lista en memoria para que la
              // búsqueda por contexto lo encuentre de inmediato (sin recargar la BD).
              const listed = state.catalogTables.find(x => x.database === db && x.name === table);
              if (listed) listed.context = body;
              notice.textContent = "Guardado.";
              notice.hidden = false;
              setTimeout(() => { notice.hidden = true; }, 2500);
            } catch (err) {
              notice.textContent = err.message || "Error al guardar.";
              notice.hidden = false;
            } finally {
              btn.disabled = false;
            }
          };
        });

        panel.querySelectorAll("textarea").forEach(ta => {
          const autoResize = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
          autoResize();
          ta.addEventListener("input", autoResize);
        });

        // ── Guardado masivo de contexto de columnas con seguimiento de cambios ──
        const saveBar = panel.querySelector(".catalogColSaveBar");
        if (saveBar) {
          const saveBtn = saveBar.querySelector(".saveAllColsBtn");
          const barMsg = saveBar.querySelector(".catalogColSaveBarMsg");

          // Una columna está "sucia" si alguno de sus campos (descripción,
          // sensibilidad, ejemplo, notas) difiere de lo guardado (data-*)
          const colValues = (colDiv) => ({
            description: colDiv.querySelector("[name=description]").value,
            sensitivity: colDiv.querySelector("[name=sensitivity]").value,
            sampleValue: colDiv.querySelector("[name=sampleValue]").value,
            notes: colDiv.querySelector("[name=notes]").value,
          });
          const dirtyColumns = () => [...panel.querySelectorAll(".catalogColumn")].filter(colDiv => {
            const v = colValues(colDiv);
            return v.description !== (colDiv.dataset.desc || "")
              || v.notes !== (colDiv.dataset.notes || "")
              || v.sensitivity !== (colDiv.dataset.sens || "")
              || v.sampleValue !== (colDiv.dataset.sample || "");
          });

          // Actualiza el contador y la barra de progreso de documentación
          const progressEl = panel.querySelector(".catalogColProgress");
          const progressBar = panel.querySelector(".catalogColProgressBar span");
          const updateProgress = () => {
            const all = [...panel.querySelectorAll(".catalogColumn")];
            const done = all.filter(c => c.querySelector("[name=description]").value.trim()).length;
            if (progressEl) progressEl.textContent = `${done} de ${all.length} documentadas`;
            if (progressBar) progressBar.style.width = (all.length ? Math.round(done / all.length * 100) : 0) + "%";
          };

          const refreshSaveBar = () => {
            const dirty = dirtyColumns();
            panel.querySelectorAll(".catalogColumn").forEach(colDiv => {
              const isDirty = dirty.includes(colDiv);
              colDiv.classList.toggle("dirty", isDirty);
              const dot = colDiv.querySelector(".catalogColDirtyDot");
              if (dot) dot.hidden = !isDirty;
            });
            const n = dirty.length;
            saveBar.hidden = n === 0;
            saveBtn.disabled = n === 0;
            saveBtn.textContent = n > 0 ? `Guardar ${n} ${n === 1 ? "cambio" : "cambios"}` : "Guardar cambios";
            barMsg.textContent = "";
          };

          panel.querySelectorAll(".catalogColumnDesc, .catalogColumnNotes, .catalogColumnSample, .catalogColumnSens").forEach(el => {
            el.addEventListener("input", refreshSaveBar);
          });
          panel.querySelectorAll(".catalogColumnDesc").forEach(el => {
            el.addEventListener("input", updateProgress);
          });

          saveBtn.onclick = async () => {
            const { db, table } = saveBar.dataset;
            const dirty = dirtyColumns();
            if (!dirty.length) return;
            saveBtn.disabled = true;
            barMsg.textContent = "Guardando…";
            const results = await Promise.allSettled(dirty.map(async colDiv => {
              const column = colDiv.dataset.column;
              const body = colValues(colDiv);
              await apiRequest(withAcct(`api/catalog/${encodeURIComponent(db)}/${encodeURIComponent(table)}/columns/${encodeURIComponent(column)}/context`), {
                method: "PUT",
                body: JSON.stringify(body),
              });
              // Persistir en estado/caché y marcar como base lo recién guardado
              const col = (state.catalogSelectedTable?.columns || []).find(c => c.name === column);
              if (col) col.context = body;
              colDiv.dataset.desc = body.description;
              colDiv.dataset.notes = body.notes;
              colDiv.dataset.sens = body.sensitivity;
              colDiv.dataset.sample = body.sampleValue;
              colDiv.dataset.documented = body.description ? "1" : "0";
              const sv = (body.sensitivity || "").trim().toLowerCase();
              colDiv.dataset.sensitive = (sv && sv !== "interna" && sv !== "interno") ? "1" : "0";
              colDiv.classList.toggle("hasCtx", Boolean(body.description || body.notes || body.sensitivity || body.sampleValue));
            }));
            const failed = results.filter(r => r.status === "rejected").length;
            refreshSaveBar();
            updateProgress();
            if (failed) {
              barMsg.textContent = `${failed} no se pudo${failed === 1 ? "" : "n"} guardar. Reintenta.`;
              saveBar.hidden = false;
            } else {
              barMsg.textContent = "Cambios guardados.";
              setTimeout(() => { if (!dirtyColumns().length) barMsg.textContent = ""; }, 2500);
            }
          };

          refreshSaveBar();
        }

        // ── Filtros de columnas (Todas / Sin descripción / Sensibles / Llaves) ──
        const colFilterChips = panel.querySelectorAll(".catalogColFilterChip");
        if (colFilterChips.length) {
          const applyColFilter = (filter) => {
            panel.querySelectorAll(".catalogColumn").forEach(colDiv => {
              const show =
                filter === "all" ||
                (filter === "undocumented" && colDiv.dataset.documented === "0") ||
                (filter === "sensitive" && colDiv.dataset.sensitive === "1") ||
                (filter === "key" && colDiv.dataset.key === "1");
              colDiv.hidden = !show;
            });
          };
          colFilterChips.forEach(chip => {
            chip.onclick = () => {
              colFilterChips.forEach(c => c.classList.toggle("active", c === chip));
              applyColFilter(chip.dataset.colFilter);
            };
          });
        }
      }

      // ── Grafo de relaciones ─────────────────────────────────────────────────

      function loadD3() {
        return new Promise((resolve, reject) => {
          if (window.d3) { resolve(); return; }
          const s = document.createElement("script");
          // Auto-hospedado en /vendor/ (d3 7.9.0): laptops corporativas con salida
          // restringida solo alcanzan dominios de AWS — no usar CDNs externos.
          s.src = "/vendor/d3.min.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("No fue posible cargar D3."));
          document.head.appendChild(s);
        });
      }

      // Precarga el detalle (columnas) de las tablas que falten en caché, con
      // concurrencia limitada. onProgress se invoca conforme llegan resultados.
      async function ensureCatalogTableDetails(tables, onProgress) {
        const pending = tables.filter(t => !state.catalogTableCache[cacheKey(t.database, t.name)]);
        if (!pending.length) return;
        const queue = [...pending];
        let done = 0;
        const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
          while (queue.length) {
            const t = queue.shift();
            try {
              const payload = await apiRequest(withAcct(`api/catalog/${encodeURIComponent(t.database)}/${encodeURIComponent(t.name)}`));
              state.catalogTableCache[cacheKey(t.database, t.name)] = payload.data;
            } catch {
              // Tabla sin detalle disponible: se omite
            }
            done++;
            if (onProgress && (done % 4 === 0 || !queue.length)) onProgress();
          }
        });
        await Promise.all(workers);
      }

      // ── Reporte CSV de la base de datos (tablas + contexto) ───────────────────
      // Una fila por columna, con el contexto de tabla repetido (cómodo para Excel
      // / tablas dinámicas). Reusa el caché de detalle (carga las tablas que falten,
      // igual que el grafo). Todo en el cliente: no requiere endpoint nuevo.
      function csvCell(v) {
        const s = (v === null || v === undefined) ? "" : String(v);
        return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      async function downloadCatalogReport() {
        const db = state.catalogSelectedDb;
        const tables = state.catalogTables || [];
        if (!db || !tables.length) { alert("Selecciona una base de datos con tablas para generar el reporte."); return; }
        const btn = elements.contentPanel.querySelector(".catalogReportBtn");
        if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; }
        try {
          await ensureCatalogTableDetails(tables);
          const headers = [
            "Base de datos", "Tabla", "Descripción tabla", "Uso principal", "Responsable",
            "Dominio", "Sensibilidad tabla", "Estado", "Notas de uso", "Formato", "Ruta S3",
            "Columna", "Tipo", "Partición", "Descripción columna", "Sensibilidad columna",
            "Ejemplo", "Notas columna",
          ];
          const rows = [headers];
          for (const t of tables) {
            const full = state.catalogTableCache[cacheKey(t.database, t.name)] || t;
            const c = full.context || {};
            const base = [
              t.database, t.name, c.description, c.usagePrimary, c.responsible,
              c.domain, c.sensitivity, c.status, c.usageNotes, full.format, full.location,
            ];
            const cols = full.columns || [];
            if (!cols.length) {
              rows.push([...base, "", "", "", "", "", "", ""]);
              continue;
            }
            for (const col of cols) {
              const cc = col.context || {};
              rows.push([
                ...base,
                col.name, col.type, col.isPartition ? "Sí" : "",
                cc.description, cc.sensitivity, cc.sampleValue, cc.notes,
              ]);
            }
          }
          const csv = rows.map(r => r.map(csvCell).join(",")).join("\r\n");
          const today = new Date().toISOString().slice(0, 10);
          const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `catalogo_${db}_${today}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          alert("No fue posible generar el reporte. Intenta de nuevo.");
        } finally {
          if (btn) { btn.disabled = false; btn.style.opacity = ""; }
        }
      }

      async function openCatalogGraph() {
        const btn = elements.contentPanel.querySelector(".catalogGraphBtn");
        if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; }
        try { await loadD3(); } catch (e) {
          alert("No fue posible cargar la librería de visualización. Verifica tu conexión.");
          if (btn) { btn.disabled = false; btn.style.opacity = ""; }
          return;
        }
        const tables = state.catalogTables;
        if (!tables.length) {
          if (btn) { btn.disabled = false; btn.style.opacity = ""; }
          alert("No hay tablas cargadas para mostrar el grafo.");
          return;
        }

        // Precarga las columnas de todas las tablas para que el grafo abra
        // completo, con relaciones ya detectadas
        await ensureCatalogTableDetails(tables);
        if (btn) { btn.disabled = false; btn.style.opacity = ""; }

        const palette = ["#1a7f6e","#2563eb","#9333ea","#ea580c","#0891b2","#16a34a","#db2777","#ca8a04"];
        const dbColors = {};
        [...new Set(tables.map(t => t.database))].forEach((db, i) => { dbColors[db] = palette[i % palette.length]; });

        renderGraphModal(tables, dbColors);
      }

      // Construye nodos y enlaces del grafo a partir de las tablas listadas y la
      // caché de detalles de tabla (state.catalogTableCache). Las columnas de tipo
      // partición se incluyen como subnodos pero quedan excluidas de relaciones
      // (FK / columnas compartidas).
      function buildCatalogGraphData(tables, dbColors) {
        const tableNodes = tables.map(t => ({
          id: `T::${t.database}::${t.name}`,
          type: "table",
          label: t.name,
          db: t.database,
          columnCount: t.columnCount || 0,
          tableType: t.tableType || "",
          isSelected: state.catalogSelectedTable?.name === t.name && state.catalogSelectedTable?.database === t.database,
        }));

        const tableNodeIds = new Set(tableNodes.map(n => n.id));

        // ── Column nodes (solo de tablas en caché) ──────────────────────────
        const columnNodes = [];
        const parentLinks  = [];
        const tableColMap  = {}; // "db::name" → Set<colName> (excluye columnas de partición)

        for (const [, tData] of Object.entries(state.catalogTableCache)) {
          const tableId = `T::${tData.database}::${tData.name}`;
          if (!tableNodeIds.has(tableId)) continue;
          tableColMap[`${tData.database}::${tData.name}`] = new Set();
          const cols = tData.columns || [];
          cols.forEach((col, colIndex) => {
            const colId = `C::${tData.database}::${tData.name}::${col.name}`;
            columnNodes.push({
              id: colId,
              type: "column",
              label: col.name,
              colType: col.type || "",
              db: tData.database,
              parentId: tableId,
              parentLabel: tData.name,
              isPartition: !!col.isPartition,
              colIndex,
              colTotal: cols.length,
            });
            parentLinks.push({ source: tableId, target: colId, type: "parent" });
            if (!col.isPartition) tableColMap[`${tData.database}::${tData.name}`].add(col.name);
          });
        }

        // ── Cross-table links ────────────────────────────────────────────────
        const crossLinks = [];
        const linkSet    = new Set();

        function addCrossLink(src, tgt, type, meta) {
          const key = [src, tgt].sort().join("|||");
          if (!linkSet.has(key) && src !== tgt) { linkSet.add(key); crossLinks.push({ source: src, target: tgt, type, ...meta }); }
        }

        // FK: col_id → matching table node (las columnas de partición no generan FK)
        for (const [, tData] of Object.entries(state.catalogTableCache)) {
          const db = tData.database;
          for (const col of (tData.columns || [])) {
            if (col.isPartition) continue;
            if (!col.name.endsWith("_id")) continue;
            const prefix = col.name.slice(0, -3);
            for (const cand of [prefix, prefix + "s", prefix + "es"]) {
              const tid = `T::${db}::${cand}`;
              if (tableNodeIds.has(tid)) {
                const srcColId = `C::${db}::${tData.name}::${col.name}`;
                addCrossLink(srcColId, tid, "fk", { colLabel: col.name });
                break;
              }
            }
          }
        }

        // Shared column names (column-to-column, same name in different tables;
        // ya excluye columnas de partición porque no se agregaron a tableColMap)
        const cacheKeys = Object.keys(tableColMap);
        for (let i = 0; i < cacheKeys.length; i++) {
          for (let j = i + 1; j < cacheKeys.length; j++) {
            const [dbA, nameA] = cacheKeys[i].split("::");
            const [dbB, nameB] = cacheKeys[j].split("::");
            for (const col of tableColMap[cacheKeys[i]]) {
              if (col === "id" || col.endsWith("_id") || col.length <= 2) continue;
              if (tableColMap[cacheKeys[j]].has(col)) {
                addCrossLink(`C::${dbA}::${nameA}::${col}`, `C::${dbB}::${nameB}::${col}`, "shared", { colLabel: col });
              }
            }
          }
        }

        return {
          nodes: [...tableNodes, ...columnNodes],
          links: [...parentLinks, ...crossLinks],
        };
      }

      // Visualizador de grafo estilo "embedding projector": render en Canvas 2D
      // con culling por viewport, etiquetas con nivel de detalle (LOD) y picking
      // espacial. Escala a decenas de miles de nodos manteniendo zoom/pan fluidos.
      function renderGraphModal(tables, dbColors) {
        document.getElementById("catalogGraphModal")?.remove();

        const dbListAll = Object.keys(dbColors);
        const modal = document.createElement("div");
        modal.id = "catalogGraphModal";
        modal.className = "catalogGraphModal";
        modal.setAttribute("tabindex", "-1");
        modal.innerHTML = `
          <div class="catalogGraphHeader">
            <div>
              <p class="eyebrow" style="margin:0">Catálogo · ${escapeHtml(state.catalogSelectedDb || "")}</p>
              <h3 style="margin:4px 0 0;font-size:1rem;font-weight:700">Grafo de relaciones</h3>
            </div>
            <div class="catalogGraphLegend">
              <span class="graphLegendFk">● Relación inferida</span>
              <span class="graphLegendShared">● Columna en común</span>
              <span class="graphLegendInfoWrap">
                <button type="button" class="graphLegendInfoBtn" aria-label="Acerca de las relaciones" aria-expanded="false" title="Acerca de las relaciones">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
                  </svg>
                </button>
                <div class="graphLegendInfoPopover" hidden>
                  <p class="graphLegendInfoTitle">Relaciones heurísticas</p>
                  <p>Estas conexiones se calculan automáticamente comparando los nombres de las columnas entre tablas. Son una guía para explorar posibles relaciones, no relaciones reales definidas en los datos.</p>
                  <p><span class="graphLegendFk">● Relación inferida</span><br/>Una columna termina en <code>_id</code> y existe una tabla cuyo nombre coincide con esa raíz (ej. <code>cliente_id</code> → tabla <code>clientes</code>). Funciona como una posible clave foránea.</p>
                  <p><span class="graphLegendShared">● Columna en común</span><br/>Dos tablas tienen una columna con exactamente el mismo nombre. Es una señal débil: no implica relación real.</p>
                  <p class="graphLegendInfoNote">Las columnas de partición se excluyen para evitar relaciones falsas.</p>
                </div>
              </span>
              <span class="graphLegendHint2">Click = seleccionar · Shift+click = ver ruta · Click derecho = abrir tabla · Esc = cerrar</span>
            </div>
            <button class="iconTinyButton catalogGraphFitBtn" type="button" title="Centrar grafo" aria-label="Centrar grafo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
                <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            </button>
            <button class="iconButton catalogGraphCloseBtn" type="button" aria-label="Cerrar">×</button>
          </div>
          <div class="catalogGraphToolbar">
            <div class="catalogGraphSearchWrap">
              <input type="search" class="catalogGraphSearch" placeholder="Buscar tabla o columna…" />
              <div class="catalogGraphSearchResults" hidden></div>
            </div>
            <div class="catalogGraphFilterChips">
              <button type="button" class="graphFilterChip graphFilterChipFk active" data-filter="fk" title="Mostrar/ocultar relaciones inferidas (columnas _id que apuntan a otra tabla)">● Relaciones inferidas</button>
              <button type="button" class="graphFilterChip graphFilterChipShared active" data-filter="shared" title="Mostrar/ocultar columnas en común (mismo nombre en distintas tablas)">● Columnas en común</button>
            </div>
            <select class="catalogGraphDbFilter" title="Filtrar por base de datos">
              <option value="all">Todas las bases de datos</option>
              ${dbListAll.map(db => `<option value="${escapeAttribute(db)}">${escapeHtml(db)}</option>`).join("")}
            </select>
          </div>
          <div class="catalogGraphBody">
            <canvas id="catalogGraphCanvas" class="catalogGraphCanvas"></canvas>
            <canvas id="catalogGraphMinimap" class="catalogGraphMinimap"></canvas>
            <aside id="catalogGraphInspector" class="catalogGraphInspector" hidden></aside>
          </div>
          <div id="catalogGraphTooltip" class="catalogGraphTooltip" hidden></div>
        `;

        document.getElementById("app").appendChild(modal);
        modal.focus();

        const inspectorEl = modal.querySelector("#catalogGraphInspector");
        const canvas = modal.querySelector("#catalogGraphCanvas");
        const bodyEl = modal.querySelector(".catalogGraphBody");
        const W = bodyEl.clientWidth || window.innerWidth;
        const H = bodyEl.clientHeight || (window.innerHeight - 110);
        const DPR = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = W * DPR;
        canvas.height = H * DPR;
        canvas.style.width = W + "px";
        canvas.style.height = H + "px";
        const ctx = canvas.getContext("2d");

        const rootStyle = getComputedStyle(document.documentElement);
        const cssVar = (name, fallback) => (rootStyle.getPropertyValue(name) || "").trim() || fallback;
        const COLOR_TEXT  = cssVar("--text", "#1f2937");
        const COLOR_PANEL = cssVar("--panel", "#ffffff");
        const COLOR_BG    = cssVar("--bg", "#eef2f1");

        // Lienzo virtual más amplio cuando hay muchas tablas (las esferas de
        // columnas son compactas, así que el factor crece despacio)
        const spread = Math.max(1, Math.sqrt(tables.length / 20));

        // ── Datos del grafo ──────────────────────────────────────────────────
        let { nodes, links } = buildCatalogGraphData(tables, dbColors);

        const linkEndId = (end) => (typeof end === "object") ? end.id : end;
        let nodeById = new Map(nodes.map(n => [n.id, n]));

        let fkColumnIds = new Set();
        let sharedColumnIds = new Set();
        let relatedColumnIds = new Set();
        function recomputeDerived() {
          nodeById = new Map(nodes.map(n => [n.id, n]));
          fkColumnIds = new Set();
          sharedColumnIds = new Set();
          links.forEach(l => {
            const s = linkEndId(l.source), t = linkEndId(l.target);
            if (l.type === "fk") { if (s.startsWith("C::")) fkColumnIds.add(s); if (t.startsWith("C::")) fkColumnIds.add(t); }
            if (l.type === "shared") { if (s.startsWith("C::")) sharedColumnIds.add(s); if (t.startsWith("C::")) sharedColumnIds.add(t); }
          });
          relatedColumnIds = new Set([...fkColumnIds, ...sharedColumnIds]);
        }
        function resolveLinks() {
          for (const l of links) {
            l.source = nodeById.get(linkEndId(l.source)) || l.source;
            l.target = nodeById.get(linkEndId(l.target)) || l.target;
          }
        }
        recomputeDerived();
        resolveLinks();

        function lighten(hex, amt) {
          const n = parseInt(hex.slice(1), 16);
          const r = Math.min(255, (n >> 16) + amt);
          const gC = Math.min(255, ((n >> 8) & 0xff) + amt);
          const b = Math.min(255, (n & 0xff) + amt);
          return `rgb(${r},${gC},${b})`;
        }

        // ── Posiciones: clusters por base de datos + anillos de columnas ───
        const dbList = Object.keys(dbColors);
        const clusterCols = Math.max(1, Math.ceil(Math.sqrt(dbList.length)));
        const clusterRows = Math.max(1, Math.ceil(dbList.length / clusterCols));
        const clusterCenters = {};
        dbList.forEach((db, i) => {
          clusterCenters[db] = {
            x: W * spread * ((i % clusterCols) + 0.5) / clusterCols,
            y: H * spread * (Math.floor(i / clusterCols) + 0.5) / clusterRows,
          };
        });

        const tableR = d => Math.max(20, Math.sqrt(d.columnCount) * 3 + 16);
        const colR   = d => 6 * (0.62 + (d.z + 1) * 0.32);

        // Distribución esférica (espiral de Fibonacci): las columnas envuelven
        // su tabla como una esfera 3D — mitad detrás, mitad delante — en vez de
        // un anillo plano gigante. Compacta el layout ~5x y da profundidad real.
        const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
        function sphereRadius(baseR, total) {
          return Math.max(baseR + 16, 4.2 * Math.sqrt(Math.max(1, total)) + 10);
        }
        function computeRingSlots() {
          for (const d of nodes) {
            if (d.type !== "column") continue;
            const total = Math.max(1, d.colTotal || 1);
            const i = d.colIndex;
            const zi = total === 1 ? 0 : 1 - (2 * (i + 0.5)) / total; // [-1, 1]
            const rUnit = Math.sqrt(Math.max(0, 1 - zi * zi));
            const phi = i * GOLDEN_ANGLE;
            // Coordenadas base de la esfera (bx/by/bz) — la rotación se aplica
            // sobre ellas sin perder la distribución original
            d.bx = rUnit * Math.cos(phi);
            d.by = rUnit * Math.sin(phi);
            d.bz = zi;
            d.sx = d.bx;
            d.sy = d.by;
            d.z = d.bz; // profundidad real de la esfera (no aleatoria)
            d.ringA = Math.atan2(d.sy, d.sx);
            const parent = nodeById.get(d.parentId);
            const baseR = parent ? tableR(parent) : 24;
            d.ringR = sphereRadius(baseR, total);
          }
        }
        function ringOuter(d) {
          const hasRing = state.catalogTableCache[cacheKey(d.db, d.label)];
          if (!hasRing) return tableR(d) + 6;
          return sphereRadius(tableR(d), d.columnCount) + 16;
        }
        function assignPositions(oldById) {
          for (const d of nodes) {
            const old = oldById.get(d.id);
            if (old) {
              d.x = old.x; d.y = old.y; d.z = old.z;
              d.vx = old.vx; d.vy = old.vy;
              continue;
            }
            if (d.type === "table") {
              const base = clusterCenters[d.db] || { x: W / 2, y: H / 2 };
              d.x = base.x + (Math.random() - 0.5) * 160;
              d.y = base.y + (Math.random() - 0.5) * 160;
              d.z = Math.random() * 2 - 1;
            }
            // Las columnas conservan la z de la esfera (computeRingSlots)
          }
        }
        function pinColumns() {
          for (const d of nodes) {
            if (d.type !== "column") continue;
            const p = nodeById.get(d.parentId);
            if (!p || p.x == null) continue;
            d.x = p.x + d.sx * d.ringR;
            d.y = p.y + d.sy * d.ringR;
          }
        }

        computeRingSlots();
        assignPositions(new Map());
        pinColumns();

        // ── Rotación 3D tipo trackball (2 ejes) sobre el núcleo de la tabla ──
        // La esfera nunca gira por hover: mantener presionado sobre la bola
        // central y arrastrar la gira en cualquier dirección (horizontal,
        // vertical o diagonal), como girar un globo. Cada tabla acumula su
        // orientación en una matriz de rotación 3x3. Doble clic = reorientar.
        const MAT_I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        function matMul(a, b) {
          const r = new Array(9);
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
            }
          }
          return r;
        }
        const rotY = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
        const rotX = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; };
        function rotAxis(u, a) {
          const [x, y, z] = u;
          const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
          return [
            c + x * x * t,     x * y * t - z * s, x * z * t + y * s,
            y * x * t + z * s, c + y * y * t,     y * z * t - x * s,
            z * x * t - y * s, z * y * t + x * s, c + z * z * t
          ];
        }
        function matAxisAngle(m) {
          const tr = m[0] + m[4] + m[8];
          const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
          if (ang < 1e-3) return null;
          const x = m[7] - m[5], y = m[2] - m[6], z = m[3] - m[1];
          const n = Math.hypot(x, y, z);
          if (n < 1e-6) {
            // ángulo ≈ 180°: eje aproximado desde la diagonal dominante
            const ax = Math.sqrt(Math.max(0, (m[0] + 1) / 2));
            const ay = Math.sqrt(Math.max(0, (m[4] + 1) / 2));
            const az = Math.sqrt(Math.max(0, (m[8] + 1) / 2));
            return { axis: [ax || 1, ay, az], angle: Math.PI };
          }
          return { axis: [x / n, y / n, z / n], angle: ang };
        }

        function rotateSphere(tableNode) {
          const m = tableNode.rotM || MAT_I;
          for (const d of nodes) {
            if (d.type !== "column" || d.parentId !== tableNode.id) continue;
            d.sx = m[0] * d.bx + m[1] * d.by + m[2] * d.bz;
            d.sy = m[3] * d.bx + m[4] * d.by + m[5] * d.bz;
            d.z  = m[6] * d.bx + m[7] * d.by + m[8] * d.bz;
            d.ringA = Math.atan2(d.sy, d.sx);
            d.x = tableNode.x + d.sx * d.ringR;
            d.y = tableNode.y + d.sy * d.ringR;
          }
        }

        let scrub = null; // { table, lastX, lastY, moved } durante el arrastre

        // Anima una rotación adicional (eje-ángulo) sobre la orientación actual
        let bringTimer = null;
        function animateRotation(p, axis, angle) {
          if (Math.abs(angle) < 0.01) return;
          bringTimer?.stop();
          const start = p.rotM || MAT_I;
          const duration = 500;
          bringTimer = d3.timer(elapsed => {
            const t = Math.min(1, elapsed / duration);
            const ease = 1 - Math.pow(1 - t, 3);
            p.rotM = matMul(rotAxis(axis, angle * ease), start);
            rotateSphere(p);
            qtDirty = true;
            dirty = true;
            if (t >= 1) { bringTimer.stop(); bringTimer = null; }
          });
        }

        // Gira la esfera hasta colocar la columna en el borde frontal derecho
        function bringColumnToFront(col) {
          const p = nodeById.get(col.parentId);
          if (!p) return;
          const m = p.rotM || MAT_I;
          const v = [
            m[0] * col.bx + m[1] * col.by + m[2] * col.bz,
            m[3] * col.bx + m[4] * col.by + m[5] * col.bz,
            m[6] * col.bx + m[7] * col.by + m[8] * col.bz
          ];
          const tgt = [1, 0, 0]; // borde derecho, profundidad 0: totalmente visible
          const dot = Math.max(-1, Math.min(1, v[0] * tgt[0] + v[1] * tgt[1] + v[2] * tgt[2]));
          let axis = [
            v[1] * tgt[2] - v[2] * tgt[1],
            v[2] * tgt[0] - v[0] * tgt[2],
            v[0] * tgt[1] - v[1] * tgt[0]
          ];
          const n = Math.hypot(axis[0], axis[1], axis[2]);
          if (n < 1e-6) {
            if (dot > 0) return; // ya está al frente
            axis = [0, 1, 0];
          } else {
            axis = [axis[0] / n, axis[1] / n, axis[2] / n];
          }
          animateRotation(p, axis, Math.acos(dot));
        }

        // Doble clic en el núcleo (o una columna): volver a la orientación base
        canvas.addEventListener("dblclick", ev => {
          const rect = canvas.getBoundingClientRect();
          const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
          if (!node) return;
          const p = node.type === "table" ? node : nodeById.get(node.parentId);
          if (!p?.rotM) return;
          // Inversa de una matriz de rotación = su transpuesta
          const inv = [p.rotM[0], p.rotM[3], p.rotM[6], p.rotM[1], p.rotM[4], p.rotM[7], p.rotM[2], p.rotM[5], p.rotM[8]];
          const aa = matAxisAngle(inv);
          if (aa) animateRotation(p, aa.axis, aa.angle);
        });

        // ── Física: solo las tablas se simulan (las columnas van ancladas) ──
        let fitted = false;
        const simulation = d3.forceSimulation(nodes.filter(d => d.type === "table"))
          .force("charge", d3.forceManyBody().strength(-200))
          .force("x", d3.forceX(d => (clusterCenters[d.db] || { x: W / 2 }).x).strength(0.06))
          .force("y", d3.forceY(d => (clusterCenters[d.db] || { y: H / 2 }).y).strength(0.06))
          .force("collision", d3.forceCollide().radius(d => ringOuter(d)))
          .alphaDecay(0.028)
          .velocityDecay(0.62)
          .on("tick", () => {
            pinColumns();
            qtDirty = true;
            dirty = true;
            if (!fitted && simulation.alpha() < 0.05) { fitted = true; fitToView(true); }
          });

        // ── Cámara (d3-zoom sobre el canvas) ────────────────────────────────
        let transform = d3.zoomIdentity;
        const sel = d3.select(canvas);
        const zoom = d3.zoom()
          .scaleExtent([0.04, 8])
          .filter(ev => {
            if (ev.type === "wheel") return true;
            if (ev.button !== 0 && ev.button !== 1) return false;
            // Arrastre iniciado sobre el núcleo de una tabla = scrub de
            // rotación, no pan del lienzo
            if (ev.type === "mousedown" && ev.button === 0) {
              const rect = canvas.getBoundingClientRect();
              const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
              if (n && n.type === "table") return false;
            }
            return true;
          })
          .on("zoom", (ev) => { transform = ev.transform; dirty = true; });
        sel.call(zoom);
        sel.on("wheel.zoom", null);
        sel.on("dblclick.zoom", null);

        // Parallax 2.5D transitorio del fondo (columnas) al desplazarse
        let parX = 0, parY = 0, parTimer = null;
        function kickParallax(dx, dy) {
          const k = transform.k || 1;
          parX = Math.max(-30, Math.min(30, parX + (dx * 0.16) / k));
          parY = Math.max(-30, Math.min(30, parY + (dy * 0.16) / k));
          dirty = true;
          if (!parTimer) {
            parTimer = d3.timer(() => {
              parX *= 0.84; parY *= 0.84;
              if (Math.abs(parX) < 0.05 && Math.abs(parY) < 0.05) {
                parX = parY = 0;
                parTimer.stop();
                parTimer = null;
              }
              dirty = true;
            });
          }
        }

        // Scroll de dos dedos / rueda = pan · pellizco o Cmd/Ctrl+rueda = zoom
        canvas.addEventListener("wheel", ev => {
          ev.preventDefault();
          if (ev.ctrlKey || ev.metaKey) {
            const factor = Math.pow(2, -ev.deltaY * 0.0035);
            zoom.scaleBy(sel, factor, d3.pointer(ev, canvas));
          } else {
            const k = transform.k || 1;
            zoom.translateBy(sel, -ev.deltaX / k, -ev.deltaY / k);
            kickParallax(ev.deltaX, ev.deltaY);
          }
        }, { passive: false });

        // ── Estado de interacción ────────────────────────────────────────────
        let selectedId = null;
        let connected = null;
        let pathNodeIds = null;
        let pathLinkSet = null;
        let searchMatches = new Set();
        let hoverId = null;
        const filterState = { fk: true, shared: true, db: "all" };

        const focusActive = () => Boolean(selectedId || pathNodeIds || searchMatches.size);
        const nodeDbVisible = d => filterState.db === "all" || d.db === filterState.db;
        function linkTypeVisible(l) {
          if (l.type === "fk" && !filterState.fk) return false;
          if (l.type === "shared" && !filterState.shared) return false;
          return true;
        }

        function updateConnected() {
          if (!selectedId) { connected = null; return; }
          connected = new Set([selectedId]);
          links.forEach(l => {
            const s = linkEndId(l.source), t = linkEndId(l.target);
            if (s === selectedId) connected.add(t);
            if (t === selectedId) connected.add(s);
          });
          for (const id of [...connected]) {
            const n = nodeById.get(id);
            if (n?.type === "column" && n.parentId) connected.add(n.parentId);
          }
        }

        // ── Picking espacial (quadtree para columnas, lineal para tablas) ──
        let quadtree = null;
        let qtDirty = true;
        function getQuadtree() {
          if (qtDirty || !quadtree) {
            quadtree = d3.quadtree(nodes.filter(d => d.type === "column"), d => d.x, d => d.y);
            qtDirty = false;
          }
          return quadtree;
        }
        function pick(mx, my) {
          const [wx, wy] = transform.invert([mx, my]);
          const k = transform.k || 1;
          if (k > colVisibleK()) {
            const col = getQuadtree().find(wx, wy, Math.max(9, 12 / k));
            if (col && nodeDbVisible(col)) {
              // Ignora columnas del hemisferio trasero ocultas tras su tabla
              const p = nodeById.get(col.parentId);
              const hiddenBehind = col.z < 0 && p && Math.hypot(col.x - p.x, col.y - p.y) < tableR(p);
              if (!hiddenBehind) return col;
            }
          }
          let best = null, bestD = Infinity;
          for (const d of nodes) {
            if (d.type !== "table" || !nodeDbVisible(d)) continue;
            const dx = wx - d.x, dy = wy - d.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= tableR(d) && dist < bestD) { best = d; bestD = dist; }
          }
          return best;
        }

        const colVisibleK = () => nodes.length > 20000 ? 0.7 : 0.4;

        // ── Opacidades según estado (replica el modelo de resaltado) ────────
        function nodeAlpha(d) {
          if (!nodeDbVisible(d)) return 0.03;
          if (pathNodeIds) return pathNodeIds.has(d.id) ? 1 : 0.06;
          if (selectedId) return connected.has(d.id) ? 1 : 0.07;
          if (searchMatches.size) return searchMatches.has(d.id) ? 1 : 0.1;
          return 1;
        }
        function linkAlpha(l) {
          if (!linkTypeVisible(l)) return 0;
          if (!nodeDbVisible(l.source) || !nodeDbVisible(l.target)) return 0;
          if (pathNodeIds) return pathLinkSet.has(l) ? 0.95 : 0.02;
          if (selectedId) {
            const on = connected.has(l.source.id) && connected.has(l.target.id);
            return on ? (l.type === "parent" ? 0.45 : 0.95) : 0.02;
          }
          if (searchMatches.size) {
            // En búsqueda, resalta las relaciones que tocan un nodo encontrado
            // (respetando el filtro de tipo); el resto queda muy tenue
            const touch = searchMatches.has(l.source.id) || searchMatches.has(l.target.id);
            if (l.type === "parent") return touch ? 0.4 : 0.05;
            return touch ? 0.9 : 0.06;
          }
          return l.type === "parent" ? 0.18 : 0; // sin foco: uniones ocultas
        }
        const isLit = d => (pathNodeIds && pathNodeIds.has(d.id))
          || (connected && connected.has(d.id))
          || searchMatches.has(d.id)
          || d.id === hoverId;

        // ── Render (solo cuando hay cambios: dirty flag) ─────────────────────
        let dirty = true;
        const renderTimer = d3.timer(() => { if (dirty) { dirty = false; draw(); } });

        function draw() {
          const k = transform.k;
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
          ctx.clearRect(0, 0, W, H);
          ctx.setTransform(DPR * k, 0, 0, DPR * k, DPR * transform.x, DPR * transform.y);

          // Límites del viewport en coordenadas de mundo (con margen)
          const m = 80 / k;
          const x0 = -transform.x / k - m, y0 = -transform.y / k - m;
          const x1 = (W - transform.x) / k + m, y1 = (H - transform.y) / k + m;
          const inView = (x, y, r = 0) => x + r > x0 && x - r < x1 && y + r > y0 && y - r < y1;

          const showCols = k > colVisibleK();
          const focus = focusActive();
          const colX = d => d.x + parX, colY = d => d.y + parY;
          const px = d => d.type === "column" ? colX(d) : d.x;
          const py = d => d.type === "column" ? colY(d) : d.y;

          // ── Enlaces ──
          ctx.lineCap = "round";
          for (const l of links) {
            if (l.type === "parent" && !showCols) continue;
            const a = linkAlpha(l);
            if (a <= 0.015) continue;
            const sx = px(l.source), sy = py(l.source);
            const tx = px(l.target), ty = py(l.target);
            if (!inView(sx, sy) && !inView(tx, ty)) continue;
            ctx.globalAlpha = a;
            if (l.type === "fk") {
              ctx.strokeStyle = "#1a7f6e"; ctx.lineWidth = 2 / k; ctx.setLineDash([]);
            } else if (l.type === "shared") {
              ctx.strokeStyle = "#6366f1"; ctx.lineWidth = 1.8 / k; ctx.setLineDash([6 / k, 3 / k]);
            } else {
              ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1 / k; ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(tx, ty);
            ctx.stroke();
          }
          ctx.setLineDash([]);

          // ── Columnas: dos pasadas 3D — detrás de la tabla (z<0) y delante ──
          function drawColumnPass(front) {
            for (const d of nodes) {
              if (d.type !== "column") continue;
              if (front ? d.z < 0 : d.z >= 0) continue;
              const x = colX(d), y = colY(d);
              if (!inView(x, y, 10)) continue;
              const a = nodeAlpha(d);
              if (a <= 0.04) continue;
              const lit = focus && isLit(d);
              const baseFill = lit ? 0.9 : 0.3 + (d.z + 1) * 0.15;
              ctx.globalAlpha = a * baseFill;
              ctx.fillStyle = dbColors[d.db] || "#1a7f6e";
              ctx.beginPath();
              ctx.arc(x, y, colR(d), 0, Math.PI * 2);
              ctx.fill();
              if (focus && lit && (fkColumnIds.has(d.id) || sharedColumnIds.has(d.id))) {
                ctx.globalAlpha = a;
                ctx.strokeStyle = fkColumnIds.has(d.id) ? "#1a7f6e" : "#6366f1";
                ctx.lineWidth = 2 / k;
                ctx.stroke();
              }
              if (d.id === hoverId) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = "#1a7f6e";
                ctx.lineWidth = 2.5 / k;
                ctx.stroke();
              }
            }
          }
          if (showCols) drawColumnPass(false);

          // ── Tablas (halo + esfera con gradiente) ──
          for (const d of nodes) {
            if (d.type !== "table") continue;
            const r = tableR(d);
            if (!inView(d.x, d.y, r * 1.5)) continue;
            const a = nodeAlpha(d);
            const color = dbColors[d.db] || "#1a7f6e";
            ctx.globalAlpha = a * 0.12;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(d.x, d.y, r * 1.4, 0, Math.PI * 2);
            ctx.fill();

            const grad = ctx.createRadialGradient(d.x - r * 0.3, d.y - r * 0.4, r * 0.1, d.x, d.y, r);
            grad.addColorStop(0, lighten(color, 70));
            grad.addColorStop(1, color);
            ctx.globalAlpha = a * 0.92;
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
            ctx.fill();

            if (d.id === selectedId || d.isSelected || d.id === hoverId) {
              ctx.globalAlpha = a;
              ctx.strokeStyle = d.id === hoverId && d.id !== selectedId ? color : "#ffffff";
              ctx.lineWidth = 2.5 / k;
              ctx.stroke();
            }
          }

          // Hemisferio frontal de columnas, por delante de las tablas (3D)
          if (showCols) drawColumnPass(true);

          // ── Etiquetas (espacio de pantalla, tamaño constante) ──
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
          const toScreen = (x, y) => [x * k + transform.x, y * k + transform.y];

          if (k > 0.22) {
            ctx.font = "700 11px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.lineWidth = 3;
            ctx.strokeStyle = COLOR_PANEL;
            for (const d of nodes) {
              if (d.type !== "table") continue;
              if (!inView(d.x, d.y, tableR(d))) continue;
              const a = nodeAlpha(d);
              if (a <= 0.05) continue;
              const [sx, sy] = toScreen(d.x, d.y + tableR(d));
              ctx.globalAlpha = Math.min(1, a);
              ctx.strokeText(d.label, sx, sy + 6);
              ctx.fillStyle = COLOR_TEXT;
              ctx.fillText(d.label, sx, sy + 6);
            }
          }

          // Etiquetas de columnas: radiales, solo en foco/hover o muy de cerca
          if (showCols) {
            const showAllColLabels = k > 1.5;
            ctx.font = "600 9px system-ui, sans-serif";
            ctx.textBaseline = "middle";
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = COLOR_PANEL;
            let labelBudget = 500;
            for (const d of nodes) {
              if (d.type !== "column" || labelBudget <= 0) continue;
              const lit = focus && isLit(d);
              const hovered = d.id === hoverId;
              if (!lit && !hovered && !showAllColLabels) continue;
              if (d.z < -0.1 && !lit && !hovered) continue; // hemisferio trasero sin etiqueta
              const x = colX(d), y = colY(d);
              if (!inView(x, y)) continue;
              const a = nodeAlpha(d);
              if (!hovered && a <= 0.15) continue;
              labelBudget--;
              const [sx, sy] = toScreen(x, y);
              const deg = d.ringA || 0;
              const flip = Math.cos(deg) < 0;
              const off = colR(d) * k + 5;
              const text = d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label;
              ctx.save();
              ctx.translate(sx, sy);
              ctx.rotate(flip ? deg + Math.PI : deg);
              ctx.textAlign = flip ? "right" : "left";
              ctx.globalAlpha = hovered ? 1 : Math.min(1, a);
              ctx.strokeText(text, flip ? -off : off, 0);
              ctx.fillStyle = fkColumnIds.has(d.id) ? "#0f5c4f" : sharedColumnIds.has(d.id) ? "#4338ca" : COLOR_TEXT;
              ctx.fillText(text, flip ? -off : off, 0);
              ctx.restore();
            }
          }

          ctx.globalAlpha = 1;
          drawMinimap();
        }

        // ── Minimapa ─────────────────────────────────────────────────────────
        const mmEl = modal.querySelector("#catalogGraphMinimap");
        const mmW = mmEl.clientWidth || 180, mmH = mmEl.clientHeight || 120;
        mmEl.width = mmW * DPR;
        mmEl.height = mmH * DPR;
        const mmCtx = mmEl.getContext("2d");
        const mmScaleX = mmW / (W * spread), mmScaleY = mmH / (H * spread);

        function drawMinimap() {
          mmCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
          mmCtx.clearRect(0, 0, mmW, mmH);
          mmCtx.fillStyle = COLOR_PANEL;
          mmCtx.fillRect(0, 0, mmW, mmH);
          for (const d of nodes) {
            if (d.type !== "table") continue;
            mmCtx.fillStyle = dbColors[d.db] || "#1a7f6e";
            mmCtx.beginPath();
            mmCtx.arc(d.x * mmScaleX, d.y * mmScaleY, 2.2, 0, Math.PI * 2);
            mmCtx.fill();
          }
          const t = transform;
          mmCtx.strokeStyle = "#1a7f6e";
          mmCtx.lineWidth = 1.5;
          mmCtx.strokeRect((-t.x / t.k) * mmScaleX, (-t.y / t.k) * mmScaleY, (W / t.k) * mmScaleX, (H / t.k) * mmScaleY);
        }

        mmEl.addEventListener("click", ev => {
          const rect = mmEl.getBoundingClientRect();
          const gx = (ev.clientX - rect.left) / mmScaleX;
          const gy = (ev.clientY - rect.top) / mmScaleY;
          const k = transform.k || 1;
          const t = d3.zoomIdentity.translate(W / 2 - gx * k, H / 2 - gy * k).scale(k);
          sel.transition().duration(400).call(zoom.transform, t);
        });

        // ── Tooltip + hover + clicks ────────────────────────────────────────
        const tooltip = document.getElementById("catalogGraphTooltip");

        canvas.addEventListener("mousedown", ev => {
          if (ev.button !== 0) return;
          const rect = canvas.getBoundingClientRect();
          const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
          if (n && n.type === "table") {
            scrub = { table: n, lastX: ev.clientX, lastY: ev.clientY, moved: false };
            canvas.style.cursor = "grabbing";
          }
        });
        window.addEventListener("mouseup", endScrub);
        function endScrub() {
          if (!scrub) return;
          // Re-ortonormaliza (Gram-Schmidt) para evitar deriva numérica
          // acumulada tras muchas rotaciones incrementales
          const m = scrub.table.rotM;
          if (m) {
            const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
            let r0 = norm([m[0], m[1], m[2]]);
            let r1 = [m[3], m[4], m[5]];
            const d01 = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
            r1 = norm([r1[0] - d01 * r0[0], r1[1] - d01 * r0[1], r1[2] - d01 * r0[2]]);
            const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
            scrub.table.rotM = [...r0, ...r1, ...r2];
          }
          canvas.style.cursor = "grab";
          // moved queda visible para que el click posterior no cambie selección
          setTimeout(() => { scrub = null; }, 0);
        }

        canvas.addEventListener("mousemove", ev => {
          // Scrub activo: el arrastre gira la esfera en cualquier dirección
          // (horizontal, vertical o diagonal, tipo trackball)
          if (scrub) {
            const dx = ev.clientX - scrub.lastX;
            const dy = ev.clientY - scrub.lastY;
            scrub.lastX = ev.clientX;
            scrub.lastY = ev.clientY;
            if (dx !== 0 || dy !== 0) {
              if (Math.abs(dx) + Math.abs(dy) > 2) scrub.moved = true;
              const p = scrub.table;
              p.rotM = matMul(matMul(rotX(dy * 0.012), rotY(dx * 0.012)), p.rotM || MAT_I);
              rotateSphere(p);
              qtDirty = true;
              dirty = true;
            }
            tooltip.hidden = true;
            return;
          }
          const rect = canvas.getBoundingClientRect();
          const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
          const newHover = node?.id || null;
          if (newHover !== hoverId) { hoverId = newHover; dirty = true; }
          canvas.style.cursor = node ? "pointer" : "grab";
          if (!node) { tooltip.hidden = true; return; }
          if (node.type === "table") {
            tooltip.innerHTML = `<strong>${escapeHtml(node.label)}</strong><br><span>${escapeHtml(node.db)}</span><br>${node.columnCount} columnas${node.tableType ? ` · <code>${escapeHtml(node.tableType)}</code>` : ""}`;
          } else {
            tooltip.innerHTML = `<strong>${escapeHtml(node.label)}</strong><br><code>${escapeHtml(node.colType)}</code>${node.isPartition ? ` · <span class="catalogPartitionBadge">partición</span>` : ""}<br><span>↑ ${escapeHtml(node.parentLabel)}</span>`;
          }
          const r = modal.getBoundingClientRect();
          tooltip.style.left = (ev.clientX - r.left + 14) + "px";
          tooltip.style.top  = (ev.clientY - r.top  - 10) + "px";
          tooltip.hidden = false;
        });
        canvas.addEventListener("mouseleave", () => { tooltip.hidden = true; hoverId = null; dirty = true; });

        canvas.addEventListener("click", ev => {
          if (scrub?.moved) return; // venía de girar la esfera, no es selección
          const rect = canvas.getBoundingClientRect();
          const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
          if (!node) { setSelection(null); return; }
          if (ev.shiftKey && selectedId && selectedId !== node.id) {
            const path = computePath(selectedId, node.id);
            if (path) {
              pathNodeIds = new Set(path.nodes);
              pathLinkSet = new Set(path.linkPath);
              dirty = true;
              renderPathInspector(path);
            } else {
              window.alert("No se encontró una ruta de relaciones entre estos dos nodos.");
            }
            return;
          }
          setSelection(node.id);
        });

        canvas.addEventListener("contextmenu", ev => {
          ev.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const node = pick(ev.clientX - rect.left, ev.clientY - rect.top);
          if (!node) return;
          const tableLabel = node.type === "table" ? node.label : node.parentLabel;
          closeModal();
          selectCatalogTable(node.db, tableLabel);
        });

        // ── Selección + inspector ────────────────────────────────────────────
        function relatedItems(id) {
          const items = [];
          links.forEach(l => {
            const s = linkEndId(l.source), t = linkEndId(l.target);
            if (s === id || t === id) {
              const otherId = s === id ? t : s;
              const other = nodeById.get(otherId);
              if (other) items.push({ node: other, type: l.type });
            }
          });
          return items;
        }

        function centerOn(d) {
          const k = Math.max(transform.k, 1);
          const t = d3.zoomIdentity.translate(W / 2 - d.x * k, H / 2 - d.y * k).scale(k);
          sel.transition().duration(450).call(zoom.transform, t);
        }

        function setSelection(id) {
          selectedId = (selectedId === id) ? null : id;
          pathNodeIds = null;
          pathLinkSet = null;
          updateConnected();
          dirty = true;
          if (selectedId) renderInspector(nodeById.get(selectedId));
          else inspectorEl.hidden = true;
        }

        function renderInspector(d) {
          const items = relatedItems(d.id);
          const fkItems     = items.filter(it => it.type === "fk");
          const sharedItems = items.filter(it => it.type === "shared");
          const colItems    = items.filter(it => it.type === "parent" && it.node.type === "column");
          const parentItems = items.filter(it => it.type === "parent" && it.node.type === "table");

          const renderList = (list, sub) => `<ul class="inspectorList">${list.map(it => `
            <li data-id="${escapeAttribute(it.node.id)}">
              <span class="inspectorItemName">${escapeHtml(it.node.label)}</span>
              ${sub && it.node.parentLabel ? `<span class="inspectorSub">${escapeHtml(it.node.parentLabel)}</span>` : ""}
              ${it.node.colType ? `<code>${escapeHtml(it.node.colType)}</code>` : ""}
            </li>`).join("")}</ul>`;

          let html = `
            <div class="inspectorHeader">
              <span class="inspectorDot" style="background:${dbColors[d.db] || "#1a7f6e"}"></span>
              <div>
                <strong>${escapeHtml(d.label)}</strong>
                <div class="inspectorMeta">${d.type === "table"
                  ? `${escapeHtml(d.db)} · ${d.columnCount} columnas${d.tableType ? ` · ${escapeHtml(d.tableType)}` : ""}`
                  : `${escapeHtml(d.colType || "")} · columna`}</div>
              </div>
            </div>`;

          if (d.type === "table") {
            html += `<button type="button" class="tinyButton inspectorOpenBtn">Abrir tabla en catálogo →</button>`;
            if (colItems.length) {
              html += `<div class="inspectorSection"><p class="inspectorSectionTitle">Columnas (${colItems.length})</p>${renderList(colItems, false)}</div>`;
            }
          } else {
            html += `<button type="button" class="tinyButton inspectorOpenBtn">Abrir tabla "${escapeHtml(d.parentLabel)}" →</button>`;
            if (parentItems.length) {
              html += `<div class="inspectorSection"><p class="inspectorSectionTitle">Pertenece a</p>${renderList(parentItems, false)}</div>`;
            }
          }

          if (fkItems.length) {
            html += `<div class="inspectorSection"><p class="inspectorSectionTitle inspectorFkTitle">● Relación inferida (${fkItems.length})</p>${renderList(fkItems, true)}</div>`;
          }
          if (sharedItems.length) {
            html += `<div class="inspectorSection"><p class="inspectorSectionTitle inspectorSharedTitle">● Columna en común (${sharedItems.length})</p>${renderList(sharedItems, true)}</div>`;
          }
          if (!fkItems.length && !sharedItems.length && d.type === "column") {
            html += `<p class="inspectorEmpty">Sin relaciones detectadas con otras tablas.</p>`;
          }

          inspectorEl.innerHTML = html;
          inspectorEl.hidden = false;

          inspectorEl.querySelector(".inspectorOpenBtn")?.addEventListener("click", () => {
            const tableLabel = d.type === "table" ? d.label : d.parentLabel;
            closeModal();
            selectCatalogTable(d.db, tableLabel);
          });

          inspectorEl.querySelectorAll("[data-id]").forEach(li => {
            li.onclick = () => {
              const target = nodeById.get(li.dataset.id);
              if (target) {
                setSelection(target.id);
                if (target.type === "column") bringColumnToFront(target);
                centerOn(target);
              }
            };
          });
        }

        // BFS para la ruta de relaciones más corta entre dos nodos
        function computePath(fromId, toId) {
          const adj = new Map();
          links.forEach(l => {
            const s = linkEndId(l.source), t = linkEndId(l.target);
            if (!adj.has(s)) adj.set(s, []);
            if (!adj.has(t)) adj.set(t, []);
            adj.get(s).push({ to: t, link: l });
            adj.get(t).push({ to: s, link: l });
          });
          const visited = new Set([fromId]);
          const queue = [[fromId, [], []]];
          while (queue.length) {
            const [cur, nodePath, linkPath] = queue.shift();
            if (cur === toId) return { nodes: [...nodePath, cur], linkPath };
            for (const { to, link } of (adj.get(cur) || [])) {
              if (!visited.has(to)) {
                visited.add(to);
                queue.push([to, [...nodePath, cur], [...linkPath, link]]);
              }
            }
          }
          return null;
        }

        function renderPathInspector(path) {
          let html = `
            <div class="inspectorHeader">
              <div>
                <strong>Ruta de relaciones</strong>
                <div class="inspectorMeta">${path.nodes.length} nodos conectados</div>
              </div>
            </div>
            <ul class="inspectorList">${path.nodes.map((id, i) => {
              const node = nodeById.get(id);
              const link = path.linkPath[i];
              const relLabel = link ? (link.type === "fk" ? "→ FK" : link.type === "shared" ? "↔ compartida" : "· columna de") : "";
              return `<li class="pathItem" data-id="${escapeAttribute(id)}">
                <span class="inspectorItemName">${i + 1}. ${escapeHtml(node.label)}</span>
                ${relLabel ? `<span class="inspectorSub">${relLabel}</span>` : ""}
              </li>`;
            }).join("")}</ul>
            <button type="button" class="tinyButton inspectorOpenBtn" id="clearPathBtn">Limpiar ruta</button>
          `;
          inspectorEl.innerHTML = html;
          inspectorEl.hidden = false;
          inspectorEl.querySelector("#clearPathBtn").onclick = () => {
            pathNodeIds = null;
            pathLinkSet = null;
            dirty = true;
            inspectorEl.hidden = true;
          };
          inspectorEl.querySelectorAll("[data-id]").forEach(li => {
            li.onclick = () => {
              const target = nodeById.get(li.dataset.id);
              if (target) centerOn(target);
            };
          });
        }

        // ── Buscador ─────────────────────────────────────────────────────────
        const searchInput = modal.querySelector(".catalogGraphSearch");
        const searchResultsEl = modal.querySelector(".catalogGraphSearchResults");
        searchInput.addEventListener("input", () => {
          const q = searchInput.value.trim().toLowerCase();
          if (!q) {
            searchMatches = new Set();
            searchResultsEl.hidden = true;
            searchResultsEl.innerHTML = "";
            dirty = true;
            return;
          }
          const matches = nodes.filter(d => d.label.toLowerCase().includes(q));
          searchMatches = new Set(matches.map(d => d.id));
          searchResultsEl.innerHTML = matches.slice(0, 8).map(d => `
            <div class="searchResultItem" data-id="${escapeAttribute(d.id)}">
              <span class="inspectorDot" style="background:${dbColors[d.db] || "#1a7f6e"}"></span>
              <span class="inspectorItemName">${escapeHtml(d.label)}</span>
              <span class="inspectorSub">${escapeHtml(d.type === "table" ? d.db : (d.parentLabel || ""))}</span>
            </div>`).join("");
          searchResultsEl.hidden = matches.length === 0;
          searchResultsEl.querySelectorAll("[data-id]").forEach(item => {
            item.onclick = () => {
              const target = nodeById.get(item.dataset.id);
              if (target) {
                searchResultsEl.hidden = true;
                setSelection(target.id);
                if (target.type === "column") bringColumnToFront(target);
                centerOn(target);
              }
            };
          });
          dirty = true;
        });

        // ── Filtros ──────────────────────────────────────────────────────────
        modal.querySelectorAll(".graphFilterChip").forEach(chip => {
          chip.addEventListener("click", () => {
            const f = chip.dataset.filter;
            filterState[f] = !filterState[f];
            chip.classList.toggle("active", filterState[f]);
            dirty = true;
          });
        });
        modal.querySelector(".catalogGraphDbFilter").addEventListener("change", ev => {
          filterState.db = ev.target.value;
          dirty = true;
        });

        // ── Encuadre ─────────────────────────────────────────────────────────
        function fitToView(animate) {
          const ts = nodes.filter(d => d.type === "table");
          const pool = ts.length ? ts : nodes;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const d of pool) {
            if (d.x < minX) minX = d.x;
            if (d.x > maxX) maxX = d.x;
            if (d.y < minY) minY = d.y;
            if (d.y > maxY) maxY = d.y;
          }
          const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
          const scale = Math.min(2.5, 0.85 / Math.max(bw / W, bh / H, 0.001));
          const tx = W / 2 - scale * (minX + maxX) / 2;
          const ty = H / 2 - scale * (minY + maxY) / 2;
          const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
          if (animate) sel.transition().duration(600).call(zoom.transform, t);
          else sel.call(zoom.transform, t);
        }

        modal.querySelector(".catalogGraphFitBtn").onclick = () => fitToView(true);

        const legendInfoBtn = modal.querySelector(".graphLegendInfoBtn");
        const legendInfoPopover = modal.querySelector(".graphLegendInfoPopover");
        legendInfoBtn.onclick = (event) => {
          event.stopPropagation();
          const open = legendInfoPopover.hidden;
          legendInfoPopover.hidden = !open;
          legendInfoBtn.setAttribute("aria-expanded", String(open));
        };
        modal.addEventListener("click", (event) => {
          if (!legendInfoPopover.hidden && !legendInfoPopover.contains(event.target) && event.target !== legendInfoBtn) {
            legendInfoPopover.hidden = true;
            legendInfoBtn.setAttribute("aria-expanded", "false");
          }
        });

        // ── Cierre (libera timers y simulación) ─────────────────────────────
        function closeModal() {
          renderTimer.stop();
          bringTimer?.stop();
          parTimer?.stop();
          simulation.stop();
          window.removeEventListener("mouseup", endScrub);
          modal.remove();
        }
        modal.querySelector(".catalogGraphCloseBtn").onclick = closeModal;
        modal.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

        dirty = true;
      }

  return { render: renderCatalog };
}
