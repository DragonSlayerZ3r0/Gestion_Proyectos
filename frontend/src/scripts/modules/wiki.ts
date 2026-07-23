// @ts-nocheck
// Módulo Wiki: base de conocimiento tipo Wikipedia. Todos los que tengan el
// módulo LEEN; solo quienes tengan el sub-permiso `wiki_editor` (check hijo en
// Administración) crean/editan — el frontend solo oculta botones, la autoridad
// es el guard del backend. Contenido markdown renderizado con mdLite (el mismo
// del chat y el reporte ejecutivo).
export function createWikiModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, mdLite } = ctx;

  const canEdit = () => (state.profile?.capabilities || []).includes("wiki_editor");
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  // ── Imágenes pegadas (Ctrl+V) ─────────────────────────────────────────────
  // En el markdown viven como `![alt](wikiimg:<token>)`; al renderizar se
  // convierten en <img> y su URL presignada de lectura se resuelve por token
  // (con caché — expiran ~15 min). El binario sube por presigned PUT directo.
  const IMG_TOKEN_RE = /!\[([^\]]*)\]\(wikiimg:([a-f0-9]{32}\.(?:png|jpg|webp|gif))\)/g;

  function renderBody(md) {
    // mdLite escapa el HTML; el patrón ![alt](wikiimg:…) sobrevive como texto
    // literal, así que se reemplaza SOBRE el HTML ya renderizado.
    return mdLite(md || "").replace(IMG_TOKEN_RE, (_m, alt, token) =>
      `<img class="wikiImg" data-wiki-img="${escapeAttribute(token)}" alt="${escapeAttribute(alt || "imagen")}" loading="lazy" />`);
  }

  async function hydrateImages(container) {
    const imgs = [...container.querySelectorAll("img[data-wiki-img]")];
    if (!imgs.length) return;
    state.wikiImgUrls = state.wikiImgUrls || {};
    for (const img of imgs) {
      const token = img.dataset.wikiImg;
      const cached = state.wikiImgUrls[token];
      if (cached && cached.exp > Date.now()) { img.src = cached.url; continue; }
      try {
        const payload = await apiRequest(`api/wiki/images/${encodeURIComponent(token)}/url`);
        const url = payload.data?.url;
        if (url) {
          // Margen de 60 s antes de la expiración real (~15 min).
          state.wikiImgUrls[token] = { url, exp: Date.now() + ((payload.data.expiresIn || 900) - 60) * 1000 };
          img.src = url;
        }
      } catch {
        img.alt = "(imagen no disponible)";
        img.classList.add("broken");
      }
    }
  }

  async function uploadPastedImage(textarea, file) {
    const insertAtCursor = (text) => {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      const pos = start + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    };
    const note = elements.contentPanel.querySelector(".wikiPasteNote");
    try {
      if (note) { note.hidden = false; note.textContent = "Subiendo imagen…"; }
      const presign = await apiRequest("api/wiki/images/presign", {
        method: "POST",
        body: JSON.stringify({ contentType: file.type, size: file.size }),
      });
      const { uploadUrl, token, contentType } = presign.data || {};
      const put = await fetch(uploadUrl, {
        method: "PUT", body: file, headers: { "Content-Type": contentType },
      });
      if (!put.ok) throw new Error("La subida de la imagen falló.");
      insertAtCursor(`\n![imagen](wikiimg:${token})\n`);
      if (note) { note.textContent = "✓ Imagen insertada"; setTimeout(() => { note.hidden = true; }, 2500); }
    } catch (err) {
      if (note) { note.textContent = err?.message || "No se pudo subir la imagen."; setTimeout(() => { note.hidden = true; }, 4000); }
      else alert(err?.message || "No se pudo subir la imagen.");
    }
  }
  // Instantes SIEMPRE en hora de Guatemala (regla docs/18).
  const fmtDT = (iso) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleString("es-GT", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala",
    });
  };

  async function loadPages() {
    state.wikiLoading = true;
    paint();
    try {
      const payload = await apiRequest("api/wiki");
      state.wikiPages = payload.data?.pages || [];
      state.wikiError = "";
    } catch (err) {
      state.wikiPages = [];
      state.wikiError = err?.message || "No se pudo cargar la Wiki.";
    }
    state.wikiLoading = false;
    // Selección inicial: la primera página (si no hay una elegida vigente).
    if (state.wikiSelectedId && !state.wikiPages.some((p) => p.pageId === state.wikiSelectedId)) {
      state.wikiSelectedId = null;
      state.wikiPage = null;
    }
    if (!state.wikiSelectedId && state.wikiPages.length) {
      await selectPage(state.wikiPages[0].pageId);
      return;
    }
    paint();
  }

  async function selectPage(pageId) {
    state.wikiSelectedId = pageId;
    state.wikiEditing = false;
    state.wikiCreating = false;
    state.wikiHistoryOpen = false;
    state.wikiRevisionView = null;
    state.wikiPage = { loading: true };
    paint();
    try {
      const payload = await apiRequest(`api/wiki/${encodeURIComponent(pageId)}`);
      state.wikiPage = payload.data;
    } catch (err) {
      state.wikiPage = { error: err?.message || "No se pudo cargar la página." };
    }
    paint();
  }

  async function savePage(form) {
    const title = form.querySelector("[name='title']").value.trim();
    const body = form.querySelector("[name='body']").value.trim();
    if (!title || !body) { alert("Título y contenido son obligatorios."); return; }
    const btn = form.querySelector(".wikiSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
    try {
      if (state.wikiCreating) {
        const payload = await apiRequest("api/wiki", {
          method: "POST", body: JSON.stringify({ title, body }) });
        state.wikiCreating = false;
        state.wikiSelectedId = payload.data.pageId;
        state.wikiPage = payload.data;
      } else {
        const payload = await apiRequest(`api/wiki/${encodeURIComponent(state.wikiSelectedId)}`, {
          method: "PATCH", body: JSON.stringify({ title, body }) });
        state.wikiPage = payload.data;
      }
      state.wikiEditing = false;
      state.wikiRevisionView = null;
      await refreshList();
    } catch (err) {
      alert(err?.message || "No se pudo guardar la página.");
      if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
      return;
    }
    paint();
  }

  async function deletePage() {
    const page = state.wikiPage;
    if (!page?.pageId) return;
    if (!window.confirm(`¿Eliminar la página "${page.title}" y todo su historial? Esta acción no se puede deshacer.`)) return;
    try {
      await apiRequest(`api/wiki/${encodeURIComponent(page.pageId)}`, { method: "DELETE" });
      state.wikiSelectedId = null;
      state.wikiPage = null;
      state.wikiEditing = false;
      await loadPages();
    } catch (err) {
      alert(err?.message || "No se pudo eliminar la página.");
    }
  }

  async function refreshList() {
    try {
      const payload = await apiRequest("api/wiki");
      state.wikiPages = payload.data?.pages || [];
    } catch { /* la lista vieja sigue siendo válida */ }
  }

  async function toggleHistory() {
    state.wikiHistoryOpen = !state.wikiHistoryOpen;
    state.wikiRevisionView = null;
    if (state.wikiHistoryOpen && state.wikiSelectedId) {
      state.wikiRevisions = { loading: true };
      paint();
      try {
        const payload = await apiRequest(`api/wiki/${encodeURIComponent(state.wikiSelectedId)}/revisions`);
        state.wikiRevisions = payload.data;
      } catch (err) {
        state.wikiRevisions = { error: err?.message || "No se pudo cargar el historial." };
      }
    }
    paint();
  }

  async function viewRevision(revId) {
    state.wikiRevisionView = { loading: true };
    paint();
    try {
      const payload = await apiRequest(
        `api/wiki/${encodeURIComponent(state.wikiSelectedId)}/revisions/${encodeURIComponent(revId)}`);
      state.wikiRevisionView = payload.data;
    } catch (err) {
      state.wikiRevisionView = { error: err?.message || "No se pudo cargar la revisión." };
    }
    paint();
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function pageListHtml() {
    const q = norm(state.wikiSearch);
    const pages = (state.wikiPages || []).filter((p) => !q || norm(p.title).includes(q));
    if (state.wikiLoading) return `<p class="wikiEmpty">Cargando…</p>`;
    if (!state.wikiPages?.length) {
      return `<p class="wikiEmpty">Aún no hay páginas.${canEdit() ? " Crea la primera con «Nueva página»." : ""}</p>`;
    }
    if (!pages.length) return `<p class="wikiEmpty">Sin resultados para "${escapeHtml(state.wikiSearch)}".</p>`;
    return pages.map((p) => `
      <button type="button" class="wikiPageItem${p.pageId === state.wikiSelectedId ? " active" : ""}" data-wiki-page="${escapeAttribute(p.pageId)}">
        <span class="wikiPageTitle">${escapeHtml(p.title)}</span>
        <span class="wikiPageMeta">${escapeHtml(p.updatedByName || p.updatedBy || "")}${p.updatedAt ? ` · ${fmtDT(p.updatedAt)}` : ""}</span>
      </button>`).join("");
  }

  function editorHtml(page) {
    // Editar página existente o crear una nueva (page = {} al crear). Si se está
    // viendo una revisión, "Usar este contenido" la precarga aquí (no auto-guarda).
    const title = state.wikiEditPrefill?.title ?? page?.title ?? "";
    const body = state.wikiEditPrefill?.body ?? page?.body ?? "";
    state.wikiEditPrefill = null;
    return `
      <form class="wikiEditor" id="wikiEditorForm">
        <input name="title" type="text" class="wikiTitleInput" placeholder="Título de la página" maxlength="200" value="${escapeAttribute(title)}" required />
        <textarea name="body" class="wikiBodyInput" rows="18" placeholder="Contenido en markdown (títulos con #, listas con -, código con \`\`\`)…" required>${escapeHtml(body)}</textarea>
        <div class="wikiEditorActions">
          <button type="submit" class="primaryButton wikiSaveBtn">Guardar</button>
          <button type="button" class="secondaryButton" id="wikiCancelBtn">Cancelar</button>
          <span class="wikiPasteNote" role="status" hidden></span>
          ${!state.wikiCreating ? `<button type="button" class="wikiDeleteBtn" id="wikiDeleteBtn" title="Eliminar la página y su historial">Eliminar página</button>` : ""}
        </div>
        <p class="wikiEditorHint">Puedes <b>pegar imágenes</b> (Ctrl+V) directo en el contenido — se suben solas y quedan como <code>![imagen](wikiimg:…)</code>. Se guarda una revisión del contenido anterior en cada edición (historial).</p>
      </form>`;
  }

  function historyHtml() {
    const data = state.wikiRevisions || {};
    if (data.loading) return `<p class="wikiEmpty">Cargando historial…</p>`;
    if (data.error) return `<p class="wikiEmpty">${escapeHtml(data.error)}</p>`;
    const revs = data.revisions || [];
    if (!revs.length) return `<p class="wikiEmpty">Sin ediciones previas: esta es la primera versión.</p>`;
    return `
      <div class="wikiRevList">
        ${revs.map((r) => `
          <button type="button" class="wikiRevItem" data-wiki-rev="${escapeAttribute(r.revId)}">
            <span>${fmtDT(r.savedAt)}</span>
            <span class="wikiRevBy">${escapeHtml(r.savedByName || r.savedBy || "")}</span>
          </button>`).join("")}
      </div>`;
  }

  function revisionViewHtml() {
    const rev = state.wikiRevisionView;
    if (!rev) return "";
    if (rev.loading) return `<p class="wikiEmpty">Cargando revisión…</p>`;
    if (rev.error) return `<p class="wikiEmpty">${escapeHtml(rev.error)}</p>`;
    return `
      <div class="wikiRevBanner">
        Revisión del ${fmtDT(rev.savedAt)}${rev.savedBy ? ` · ${escapeHtml(rev.savedBy)}` : ""} (solo lectura)
        ${canEdit() ? `<button type="button" class="tinyButton" id="wikiRestoreBtn" title="Abre el editor con este contenido (no guarda hasta que tú guardes)">Usar este contenido</button>` : ""}
        <button type="button" class="tinyButton ghost" id="wikiCloseRevBtn">Volver a la versión actual</button>
      </div>
      <h2 class="wikiPageHeading">${escapeHtml(rev.title)}</h2>
      <div class="wikiBody">${renderBody(rev.body)}</div>`;
  }

  function mainHtml() {
    if (state.wikiCreating) return editorHtml({});
    const page = state.wikiPage;
    if (!state.wikiPages?.length && !state.wikiLoading) {
      return `<div class="wikiWelcome">
        <h3>Wiki interna</h3>
        <p>Documenta procesos, acuerdos y conocimiento del equipo. ${canEdit() ? "Crea la primera página para empezar." : "Aún no hay contenido publicado."}</p>
      </div>`;
    }
    if (!page) return `<p class="wikiEmpty">Selecciona una página.</p>`;
    if (page.loading) return `<p class="wikiEmpty">Cargando…</p>`;
    if (page.error) return `<p class="wikiEmpty">${escapeHtml(page.error)}</p>`;
    if (state.wikiEditing) return editorHtml(page);
    if (state.wikiRevisionView) return revisionViewHtml();
    return `
      <div class="wikiPageHead">
        <h2 class="wikiPageHeading">${escapeHtml(page.title)}</h2>
        <div class="wikiPageActions">
          ${canEdit() ? `<button type="button" class="secondaryButton compact" id="wikiEditBtn">Editar</button>` : ""}
          <button type="button" class="tinyButton ghost" id="wikiHistoryBtn" aria-expanded="${state.wikiHistoryOpen ? "true" : "false"}">Historial${page.revisionCount ? ` (${page.revisionCount})` : ""}</button>
        </div>
      </div>
      <p class="wikiPageInfo">Última edición: ${escapeHtml(page.updatedByName || page.updatedBy || "—")}${page.updatedAt ? ` · ${fmtDT(page.updatedAt)}` : ""}</p>
      ${state.wikiHistoryOpen ? `<div class="wikiHistory">${historyHtml()}</div>` : ""}
      <div class="wikiBody">${renderBody(page.body)}</div>`;
  }

  function paint() {
    if (state.activeModule !== "wiki") return;
    elements.contentPanel.innerHTML = `
      <div class="wikiLayout">
        <aside class="wikiSidebar">
          <div class="wikiSidebarHead">
            <p class="eyebrow">Páginas</p>
            ${canEdit() ? `<button type="button" class="primaryButton compact" id="wikiNewBtn">Nueva página</button>` : ""}
          </div>
          <input type="search" class="searchInput wikiSearch" placeholder="Buscar página…" value="${escapeAttribute(state.wikiSearch || "")}" />
          <nav class="wikiPageList">${pageListHtml()}</nav>
          ${!canEdit() ? `<p class="wikiReadOnlyNote">Solo lectura. Pide a un administrador el permiso de editor si necesitas publicar.</p>` : ""}
        </aside>
        <section class="wikiMain">${state.wikiError ? `<p class="wikiEmpty">${escapeHtml(state.wikiError)}</p>` : mainHtml()}</section>
      </div>`;
    bind();
  }

  // Filtra el sidebar SIN repintar el módulo (regla docs/06: el input de un
  // buscador en vivo debe sobrevivir — en móvil, destruirlo cierra el teclado).
  function applyWikiSearch() {
    const list = elements.contentPanel.querySelector(".wikiPageList");
    if (!list) return;
    list.innerHTML = pageListHtml();
    list.querySelectorAll("[data-wiki-page]").forEach((btn) => {
      btn.onclick = () => selectPage(btn.dataset.wikiPage);
    });
  }

  function bind() {
    const panel = elements.contentPanel;
    panel.querySelectorAll("[data-wiki-page]").forEach((btn) => {
      btn.onclick = () => selectPage(btn.dataset.wikiPage);
    });
    const search = panel.querySelector(".wikiSearch");
    if (search) search.oninput = (e) => { state.wikiSearch = e.target.value; applyWikiSearch(); };
    panel.querySelector("#wikiNewBtn")?.addEventListener("click", () => {
      state.wikiCreating = true; state.wikiEditing = false;
      state.wikiHistoryOpen = false; state.wikiRevisionView = null;
      paint();
      panel.querySelector(".wikiTitleInput")?.focus();
    });
    panel.querySelector("#wikiEditBtn")?.addEventListener("click", () => {
      state.wikiEditing = true; state.wikiHistoryOpen = false; state.wikiRevisionView = null;
      paint();
    });
    panel.querySelector("#wikiCancelBtn")?.addEventListener("click", () => {
      state.wikiEditing = false; state.wikiCreating = false;
      paint();
    });
    panel.querySelector("#wikiDeleteBtn")?.addEventListener("click", deletePage);
    panel.querySelector("#wikiHistoryBtn")?.addEventListener("click", toggleHistory);
    panel.querySelector("#wikiCloseRevBtn")?.addEventListener("click", () => {
      state.wikiRevisionView = null; paint();
    });
    panel.querySelector("#wikiRestoreBtn")?.addEventListener("click", () => {
      const rev = state.wikiRevisionView;
      if (!rev?.body) return;
      state.wikiEditPrefill = { title: rev.title, body: rev.body };
      state.wikiEditing = true; state.wikiRevisionView = null; state.wikiHistoryOpen = false;
      paint();
    });
    panel.querySelectorAll("[data-wiki-rev]").forEach((btn) => {
      btn.onclick = () => viewRevision(btn.dataset.wikiRev);
    });
    panel.querySelector("#wikiEditorForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      savePage(e.target);
    });
    // Pegar imágenes (Ctrl+V) en el textarea: sube a S3 vía presign y deja el
    // token markdown en el cursor. El texto normal se pega igual que siempre.
    const bodyInput = panel.querySelector(".wikiBodyInput");
    if (bodyInput) {
      bodyInput.addEventListener("paste", (e) => {
        const items = [...(e.clipboardData?.items || [])];
        const imgItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
        if (!imgItem) return;                 // texto → comportamiento nativo
        const file = imgItem.getAsFile();
        if (!file) return;
        e.preventDefault();
        uploadPastedImage(bodyInput, file);
      });
    }
    // Resuelve las URLs presignadas de las imágenes del artículo/revisión.
    const body = panel.querySelector(".wikiBody");
    if (body) hydrateImages(body);
  }

  return {
    render() {
      // Todo módulo debe hacer este toggle: al RECARGAR directo en el módulo,
      // el placeholder de arranque (statusPanel) sigue visible y el contenido
      // oculto — sin esto la vista se queda en "Base técnica" (bug 2026-07-22).
      elements.statusPanel.hidden = true;
      elements.contentPanel.hidden = false;
      elements.viewTitle.textContent = "Wiki";
      if (!state.wikiPages) {
        state.wikiPages = null;
        loadPages();
        return;
      }
      paint();
      // Refresco silencioso al entrar (otro editor pudo publicar).
      refreshList().then(() => paint());
    },
  };
}
