// @ts-nocheck
// Módulo Pizarra (draw): lienzo Excalidraw con compartir selectivo.
//
// - El editor es Excalidraw REAL (open source), cargado BAJO DEMANDA desde unpkg
//   (mismo patrón que D3 en el grafo del catálogo): React 18 UMD + Excalidraw UMD
//   solo se descargan al entrar al módulo — la app sigue vanilla y el bundle no
//   engorda para quien no usa Pizarra.
// - La escena se guarda como JSON (.excalidraw) en S3 vía URL prefirmada (nunca
//   pasa por la API); metadata y compartidos en DynamoDB (backend draw_routes).
// - Compartir: el dueño invita a usuarios concretos; el invitado ACEPTA o RECHAZA
//   desde el banner de invitaciones. Sin aceptar, no ve la pizarra.
export function createDrawModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton } = ctx;

  // AUTO-HOSPEDADO (2026-07-07): los archivos viven en /vendor/ del propio bucket
  // del frontend (frontend/public/vendor/, versiones fijadas: React 18.2.0 +
  // Excalidraw 0.17.6). NO usar CDNs externos (unpkg/jsdelivr): laptops
  // corporativas con salida restringida solo alcanzan los dominios de AWS.
  const CDN = {
    react: "/vendor/react.production.min.js",
    reactDom: "/vendor/react-dom.production.min.js",
    excalidraw: "/vendor/excalidraw/excalidraw.production.min.js",
  };
  let excaliLoadPromise = null; // carga única de los scripts por sesión
  let excaliRoot = null;        // React root montado (para desmontar limpio)
  let excaliAPI = null;         // API imperativa de Excalidraw (getSceneElements…)

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
      document.head.append(s);
    });
  }

  async function loadExcalidraw() {
    if (window.ExcalidrawLib) return;
    if (!excaliLoadPromise) {
      // Fuentes e idiomas del editor, también auto-hospedados: la ruta debe ser la
      // carpeta que CONTIENE excalidraw-assets/ (equivalente al dist/ del paquete).
      window.EXCALIDRAW_ASSET_PATH = "/vendor/excalidraw/";
      excaliLoadPromise = (async () => {
        await loadScript(CDN.react);
        await loadScript(CDN.reactDom);
        await loadScript(CDN.excalidraw);
      })();
    }
    await excaliLoadPromise;
  }

  function unmountEditor() {
    if (excaliRoot) {
      try { excaliRoot.unmount(); } catch {}
      excaliRoot = null;
    }
    excaliAPI = null;
  }

  // ── Render principal ──────────────────────────────────────────────────────
  async function render() {
    elements.statusPanel.hidden = true;
    elements.contentPanel.hidden = false;
    if (state.drawView === "editor" && state.drawActive) {
      renderEditor();
      return;
    }
    unmountEditor();
    if (!state.drawData && !state.drawError) {
      elements.contentPanel.innerHTML = `<section class="panel"><p class="emptyText">Cargando pizarras…</p></section>`;
      try {
        const payload = await apiRequest("api/draw");
        state.drawData = payload.data;
      } catch (error) {
        state.drawError = error.message;
      }
      // Solo repintar si el usuario sigue en Pizarra (pudo navegar a otro módulo).
      if (state.activeModule !== "draw") return;
    }
    renderList();
  }

  function renderList() {
    const data = state.drawData || { mine: [], shared: [], invitations: [] };
    const error = state.drawError;
    elements.viewTitle.textContent = "Pizarra";
    elements.contentPanel.innerHTML = `
      <section class="drawModule">
        ${error ? `<section class="panel"><p class="attachStatus error">${escapeHtml(error)}</p></section>` : ""}
        ${data.invitations.length ? `
        <section class="panel drawInvites">
          <h3>Invitaciones pendientes</h3>
          <p class="helperText">Te compartieron estas pizarras. Al aceptar, podrás verlas y editarlas.</p>
          ${data.invitations.map((d) => `
            <div class="drawInviteRow">
              <span><strong>${escapeHtml(d.name)}</strong> · de ${escapeHtml(d.ownerName)}</span>
              <span class="drawInviteActions">
                <button class="tinyButton" type="button" data-draw-respond="${d.id}:accept">Aceptar</button>
                <button class="tinyButton ghost" type="button" data-draw-respond="${d.id}:decline">Rechazar</button>
              </span>
            </div>`).join("")}
        </section>` : ""}

        <section class="panel">
          <div class="drawListHead">
            <h3>Mis pizarras <span class="countPill subtle">${data.mine.length}</span></h3>
            <form id="drawCreateForm" class="inlineForm">
              <input name="name" type="text" placeholder="Nombre de la pizarra nueva" required maxlength="120" />
              <button class="primaryButton" type="submit">Nueva pizarra</button>
            </form>
          </div>
          ${data.mine.length ? `<div class="drawGrid">${data.mine.map((d) => renderCard(d, true)).join("")}</div>`
            : `<p class="emptyText">Aún no tienes pizarras. Crea la primera para diagramar flujos, arquitecturas o ideas.</p>`}
        </section>

        ${data.shared.length ? `
        <section class="panel">
          <h3>Compartidas conmigo <span class="countPill subtle">${data.shared.length}</span></h3>
          <div class="drawGrid">${data.shared.map((d) => renderCard(d, false)).join("")}</div>
        </section>` : ""}
      </section>`;
    bindListEvents();
  }

  function renderCard(d, isMine) {
    const accepted = d.shares.filter((s) => s.status === "accepted").length;
    const pending = d.shares.filter((s) => s.status === "pending").length;
    const shareInfo = isMine && (accepted || pending)
      ? `<span class="drawCardShares">${accepted ? `${accepted} con acceso` : ""}${accepted && pending ? " · " : ""}${pending ? `${pending} sin aceptar` : ""}</span>`
      : (!isMine ? `<span class="drawCardShares">de ${escapeHtml(d.ownerName)}</span>` : "");
    return `
      <article class="drawCard" data-draw-open="${d.id}">
        <div class="drawCardBody">
          <strong>${escapeHtml(d.name)}</strong>
          <span class="drawCardMeta">${drawDateLabel(d.updatedAt)}</span>
          ${shareInfo}
        </div>
        ${isMine ? `
        <div class="drawCardActions">
          ${renderEditIconButton("Renombrar pizarra", `data-draw-rename="${d.id}"`)}
          ${renderDeleteIconButton("Eliminar pizarra", `data-draw-delete="${d.id}"`)}
        </div>` : ""}
      </article>`;
  }

  function drawDateLabel(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("es-GT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function bindListEvents() {
    document.querySelector("#drawCreateForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input[name='name']");
      const name = (input.value || "").trim();
      if (!name) return;
      try {
        const payload = await apiRequest("api/draw", { method: "POST", body: JSON.stringify({ name }) });
        state.drawData.mine.unshift(payload.data);
        openEditor(payload.data);
      } catch (error) {
        alert(error.message);
      }
    });
    for (const card of document.querySelectorAll("[data-draw-open]")) {
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-draw-rename],[data-draw-delete]")) return;
        const drawing = findDrawing(card.dataset.drawOpen);
        if (drawing) openEditor(drawing);
      });
    }
    for (const btn of document.querySelectorAll("[data-draw-rename]")) {
      btn.addEventListener("click", async () => {
        const drawing = findDrawing(btn.dataset.drawRename);
        if (!drawing) return;
        const name = window.prompt("Nuevo nombre de la pizarra:", drawing.name);
        if (!name || !name.trim() || name.trim() === drawing.name) return;
        try {
          const payload = await apiRequest(`api/draw/${drawing.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
          Object.assign(drawing, payload.data);
          renderList();
        } catch (error) {
          alert(error.message);
        }
      });
    }
    for (const btn of document.querySelectorAll("[data-draw-delete]")) {
      btn.addEventListener("click", async () => {
        const drawing = findDrawing(btn.dataset.drawDelete);
        if (!drawing) return;
        if (!window.confirm(`¿Eliminar la pizarra "${drawing.name}"? No se puede deshacer.`)) return;
        try {
          await apiRequest(`api/draw/${drawing.id}`, { method: "DELETE" });
          state.drawData.mine = state.drawData.mine.filter((d) => d.id !== drawing.id);
          renderList();
        } catch (error) {
          alert(error.message);
        }
      });
    }
    for (const btn of document.querySelectorAll("[data-draw-respond]")) {
      btn.addEventListener("click", async () => {
        const [id, action] = btn.dataset.drawRespond.split(":");
        try {
          await apiRequest(`api/draw/${id}/respond`, { method: "POST", body: JSON.stringify({ accept: action === "accept" }) });
          state.drawData = null; // recarga (la invitación cambió de lista)
          state.drawError = "";
          render();
        } catch (error) {
          alert(error.message);
        }
      });
    }
  }

  function findDrawing(id) {
    const data = state.drawData || { mine: [], shared: [] };
    return data.mine.find((d) => d.id === id) || data.shared.find((d) => d.id === id) || null;
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  function openEditor(drawing) {
    state.drawView = "editor";
    state.drawActive = drawing;
    state.drawShareOpen = false;
    render();
  }

  async function renderEditor() {
    const drawing = state.drawActive;
    const isOwner = drawing.ownerUserId === state.profile?.user?.email || !drawing.ownerUserId;
    elements.viewTitle.textContent = `Pizarra · ${drawing.name}`;
    elements.contentPanel.innerHTML = `
      <section class="panel drawEditorPanel">
        <div class="drawEditorBar">
          <button class="tinyButton ghost" type="button" id="drawBackBtn">← Volver</button>
          <strong class="drawEditorName">${escapeHtml(drawing.name)}</strong>
          <div class="drawEditorActions">
            ${isOwner ? `<button class="tinyButton ghost" type="button" id="drawShareBtn">Compartir</button>` : ""}
            <button class="primaryButton compact" type="button" id="drawSaveBtn">Guardar</button>
          </div>
        </div>
        ${state.drawShareOpen && isOwner ? renderSharePanel(drawing) : ""}
        <p id="drawEditorStatus" class="attachStatus" role="status" hidden></p>
        <div id="drawEditorHost" class="drawEditorHost"><p class="emptyText drawLoadingHint">Cargando el editor…</p></div>
      </section>`;
    bindEditorEvents(drawing, isOwner);
    await mountExcalidraw(drawing);
  }

  function renderSharePanel(drawing) {
    const people = state.drawPeople || [];
    const shared = new Set(drawing.shares.map((s) => s.userId));
    const options = people.filter((p) => !shared.has(p.email));
    return `
      <div class="drawSharePanel">
        <div class="drawShareForm">
          <select id="drawShareSelect" aria-label="Usuario con quien compartir">
            <option value="">Compartir con…</option>
            ${options.map((p) => `<option value="${escapeAttribute(p.email)}">${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <button class="tinyButton" type="button" id="drawShareInvite">Invitar</button>
        </div>
        ${drawing.shares.length ? `
        <div class="drawShareList">
          ${drawing.shares.map((s) => `
            <span class="drawShareChip ${s.status}">
              ${escapeHtml(s.userName || s.userId)}
              <em>${s.status === "accepted" ? "con acceso" : "sin aceptar"}</em>
              <button type="button" class="drawShareRevoke" data-draw-revoke="${escapeAttribute(s.userId)}" title="Quitar acceso" aria-label="Quitar acceso a ${escapeAttribute(s.userName || s.userId)}">×</button>
            </span>`).join("")}
        </div>` : `<p class="helperText">Aún no está compartida: solo tú la ves. El invitado debe aceptar para verla.</p>`}
      </div>`;
  }

  function bindEditorEvents(drawing, isOwner) {
    document.querySelector("#drawBackBtn")?.addEventListener("click", () => {
      state.drawView = "list";
      state.drawActive = null;
      state.drawShareOpen = false;
      unmountEditor();
      render();
    });
    document.querySelector("#drawSaveBtn")?.addEventListener("click", () => saveScene(drawing));
    document.querySelector("#drawShareBtn")?.addEventListener("click", async () => {
      state.drawShareOpen = !state.drawShareOpen;
      if (state.drawShareOpen && !state.drawPeople) {
        try {
          const payload = await apiRequest("api/draw/users");
          state.drawPeople = payload.data;
        } catch (error) {
          alert(error.message);
          state.drawShareOpen = false;
        }
      }
      renderEditor();
    });
    document.querySelector("#drawShareInvite")?.addEventListener("click", async () => {
      const select = document.querySelector("#drawShareSelect");
      const email = select?.value || "";
      if (!email) return;
      try {
        const payload = await apiRequest(`api/draw/${drawing.id}/shares`, { method: "POST", body: JSON.stringify({ email }) });
        const person = (state.drawPeople || []).find((p) => p.email === email);
        drawing.shares.push({ ...payload.data, userName: person?.name || email });
        renderEditor();
      } catch (error) {
        alert(error.message);
      }
    });
    for (const btn of document.querySelectorAll("[data-draw-revoke]")) {
      btn.addEventListener("click", async () => {
        const email = btn.dataset.drawRevoke;
        if (!window.confirm("¿Quitar el acceso de este usuario a la pizarra?")) return;
        try {
          await apiRequest(`api/draw/${drawing.id}/shares/${encodeURIComponent(email)}`, { method: "DELETE" });
          drawing.shares = drawing.shares.filter((s) => s.userId !== email);
          renderEditor();
        } catch (error) {
          alert(error.message);
        }
      });
    }
  }

  async function mountExcalidraw(drawing) {
    const host = document.querySelector("#drawEditorHost");
    if (!host) return;
    try {
      // Carga del editor y de la escena EN PARALELO (el editor pesa ~1 MB la
      // primera vez; después queda cacheado por el navegador y por la sesión).
      const [, scene] = await Promise.all([loadExcalidraw(), loadScene(drawing)]);
      // El usuario pudo salir del editor mientras cargaba.
      if (state.activeModule !== "draw" || state.drawView !== "editor" || !document.body.contains(host)) return;
      unmountEditor();
      host.innerHTML = "";
      const initialData = scene ? {
        elements: scene.elements || [],
        // collaborators viene serializado como objeto plano y Excalidraw espera
        // un Map — se quita para evitar el crash conocido al restaurar escenas.
        appState: { ...(scene.appState || {}), collaborators: undefined },
        files: scene.files || {},
      } : null;
      excaliRoot = window.ReactDOM.createRoot(host);
      excaliRoot.render(window.React.createElement(window.ExcalidrawLib.Excalidraw, {
        langCode: "es-ES",
        initialData,
        excalidrawAPI: (api) => { excaliAPI = api; },
      }));
    } catch (error) {
      host.innerHTML = `<p class="attachStatus error">No se pudo cargar el editor: ${escapeHtml(error.message)}. Revisa la conexión e intenta de nuevo.</p>`;
    }
  }

  async function loadScene(drawing) {
    try {
      const payload = await apiRequest(`api/draw/${drawing.id}/url`);
      const response = await fetch(payload.data.url);
      if (!response.ok) return null; // pizarra nueva: aún no hay escena guardada
      return await response.json();
    } catch {
      return null;
    }
  }

  async function saveScene(drawing) {
    if (!excaliAPI || !window.ExcalidrawLib) return;
    const statusEl = document.querySelector("#drawEditorStatus");
    const saveBtn = document.querySelector("#drawSaveBtn");
    const show = (text, isError) => {
      if (!statusEl) return;
      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.className = `attachStatus${isError ? " error" : ""}`;
    };
    try {
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Guardando…"; }
      const json = window.ExcalidrawLib.serializeAsJSON(
        excaliAPI.getSceneElements(), excaliAPI.getAppState(), excaliAPI.getFiles(), "local");
      const presign = await apiRequest(`api/draw/${drawing.id}/save-url`, { method: "POST" });
      const put = await fetch(presign.data.url, {
        method: "PUT",
        headers: { "content-type": presign.data.contentType },
        body: json,
      });
      if (!put.ok) throw new Error("No se pudo subir la escena al almacenamiento.");
      drawing.updatedAt = new Date().toISOString();
      show("✓ Guardado", false);
      setTimeout(() => { if (statusEl) statusEl.hidden = true; }, 2500);
    } catch (error) {
      show(error.message, true);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Guardar"; }
    }
  }

  return { render };
}
