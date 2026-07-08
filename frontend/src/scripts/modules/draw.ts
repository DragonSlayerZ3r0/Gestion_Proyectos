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

  // ── Estado de colaboración en vivo (WebSocket) ────────────────────────────
  let collabSocket = null;      // WebSocket de la sala del tablero abierto
  let collabDrawingId = null;   // id del tablero de la sala actual
  let collabReady = false;      // socket abierto y con "hello" enviado
  const collaborators = new Map();  // senderConn → {username, pointer, button, color} (cursores)
  const presenceIds = new Set();    // conexiones de OTROS en la sala (para el conteo)
  const syncedVersions = new Map(); // elementId → última versión difundida o recibida (anti-eco)
  let collabDirty = false;      // hubo cambios locales sin autoguardar
  let pointerTs = 0;            // throttle de cursor
  let sceneSendTs = 0;          // throttle de escena
  let sceneSendTimer = null;
  let collabPushTimer = null;   // throttle de updateScene({collaborators})
  let autosaveTimer = null;

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
    leaveCollab();
    if (excaliRoot) {
      try { excaliRoot.unmount(); } catch {}
      excaliRoot = null;
    }
    excaliAPI = null;
  }

  // ── Colaboración en vivo ───────────────────────────────────────────────────
  // Cada tablero abierto es una "sala" en la API WebSocket (serverless, dentro
  // de la cuenta — decisión 2026-07-08, ver bitácora). El servidor solo releva:
  // los navegadores difunden sus elementos cambiados y su cursor, y reconcilian
  // los remotos por (version, versionNonce) — el de mayor versión gana.
  const CURSOR_COLORS = ["#e64980", "#0ca678", "#4c6ef5", "#f76707", "#7048e8", "#0c8599"];
  function cursorColor(key) {
    let h = 0;
    for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return CURSOR_COLORS[h % CURSOR_COLORS.length];
  }

  function wsSend(payload) {
    if (collabReady && collabSocket?.readyState === WebSocket.OPEN) {
      try { collabSocket.send(JSON.stringify(payload)); } catch {}
    }
  }

  function setCollabStatus(text, isError) {
    const el = document.querySelector("#drawPresence");
    if (!el) return;
    const others = presenceIds.size;
    if (text) {
      el.hidden = false;
      el.textContent = text;
      el.className = `drawPresence ${isError ? "off" : ""}`;
      return;
    }
    el.hidden = false;
    el.className = "drawPresence live";
    el.textContent = others ? `● ${others + 1} en vivo` : "● Solo tú";
    el.title = [...collaborators.values()].map((c) => c.username).filter(Boolean).join(", ");
  }

  function joinCollab(drawing) {
    const wsUrl = state.config?.wsUrl;
    if (!wsUrl || !state.user?.accessToken) return; // sin WS configurado: editor funciona igual, sin vivo
    leaveCollab();
    collabDrawingId = drawing.id;
    setCollabStatus("Conectando…");
    const url = `${wsUrl}?token=${encodeURIComponent(state.user.accessToken)}&drawingId=${encodeURIComponent(drawing.id)}`;
    let socket;
    try { socket = new WebSocket(url); } catch { setCollabStatus("Sin conexión en vivo", true); return; }
    collabSocket = socket;
    socket.onopen = () => {
      if (socket !== collabSocket) return;
      collabReady = true;
      wsSend({ type: "hello" });
      setCollabStatus();
    };
    socket.onmessage = (event) => {
      if (socket !== collabSocket) return;
      try { handleCollabMessage(JSON.parse(event.data)); } catch {}
    };
    socket.onclose = () => {
      if (socket !== collabSocket) return;
      collabReady = false;
      // Reintento suave mientras el editor de ESTE tablero siga abierto (el
      // token pudo renovarse; joinCollab arma la URL de nuevo).
      if (state.drawView === "editor" && state.drawActive?.id === collabDrawingId) {
        setCollabStatus("Reconectando…", true);
        window.setTimeout(() => {
          if (state.drawView === "editor" && state.drawActive?.id === collabDrawingId && !collabReady) {
            joinCollab(state.drawActive);
          }
        }, 3000);
      }
    };
  }

  function leaveCollab() {
    if (collabPushTimer) { clearTimeout(collabPushTimer); collabPushTimer = null; }
    if (sceneSendTimer) { clearTimeout(sceneSendTimer); sceneSendTimer = null; }
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
    collabReady = false;
    collabDrawingId = null;
    collaborators.clear();
    presenceIds.clear();
    syncedVersions.clear();
    collabDirty = false;
    if (collabSocket) {
      const socket = collabSocket;
      collabSocket = null;
      try { socket.close(); } catch {}
    }
  }

  function handleCollabMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "members":
        presenceIds.clear();
        for (const member of msg.members || []) {
          presenceIds.add(member.connectionId);
          collaborators.set(member.connectionId, {
            username: member.userName || member.userId,
            color: { background: cursorColor(member.connectionId), stroke: cursorColor(member.connectionId) },
          });
        }
        pushCollaborators();
        setCollabStatus();
        break;
      case "join":
        presenceIds.add(msg.senderConn);
        collaborators.set(msg.senderConn, {
          username: msg.senderName || msg.senderId,
          color: { background: cursorColor(msg.senderConn), stroke: cursorColor(msg.senderConn) },
        });
        pushCollaborators();
        setCollabStatus();
        break;
      case "leave":
        presenceIds.delete(msg.senderConn);
        collaborators.delete(msg.senderConn);
        pushCollaborators();
        setCollabStatus();
        break;
      case "init-request":
        // Un recién llegado necesita la escena: se la mando directo (vía servidor).
        if (excaliAPI) {
          wsSend({
            type: "init-response",
            to: msg.from,
            elements: excaliAPI.getSceneElements(),
            files: excaliAPI.getFiles(),
          });
        }
        break;
      case "init-response":
      case "scene":
        applyRemoteScene(msg);
        break;
      case "pointer": {
        const entry = collaborators.get(msg.senderConn) || {
          username: msg.senderName || msg.senderId,
          color: { background: cursorColor(msg.senderConn), stroke: cursorColor(msg.senderConn) },
        };
        entry.pointer = msg.pointer;
        entry.button = msg.button || "up";
        collaborators.set(msg.senderConn, entry);
        pushCollaborators();
        break;
      }
    }
  }

  // Cursores/presencia → Excalidraw espera un Map en appState.collaborators.
  // Throttle corto: los pointers llegan a alta frecuencia.
  function pushCollaborators() {
    if (collabPushTimer || !excaliAPI) return;
    collabPushTimer = setTimeout(() => {
      collabPushTimer = null;
      if (!excaliAPI) return;
      try { excaliAPI.updateScene({ collaborators: new Map(collaborators) }); } catch {}
    }, 60);
  }

  // Reconciliación: por elemento gana la versión mayor (a igual versión, el
  // versionNonce menor — mismo criterio que Excalidraw). Nada se interpreta:
  // los borrados viajan como isDeleted=true.
  function applyRemoteScene(msg) {
    if (!excaliAPI) return;
    const remote = msg.elements || [];
    if (!remote.length && !msg.files) return;
    const local = excaliAPI.getSceneElementsIncludingDeleted
      ? excaliAPI.getSceneElementsIncludingDeleted()
      : excaliAPI.getSceneElements();
    const byId = new Map(local.map((el) => [el.id, el]));
    let changed = false;
    for (const el of remote) {
      if (!el?.id) continue;
      const mine = byId.get(el.id);
      const wins = !mine
        || el.version > mine.version
        || (el.version === mine.version && (el.versionNonce || 0) < (mine.versionNonce || 0));
      if (wins) {
        byId.set(el.id, el);
        changed = true;
      }
      // Anti-eco: lo recibido cuenta como sincronizado (no re-difundirlo).
      const known = syncedVersions.get(el.id) || 0;
      syncedVersions.set(el.id, Math.max(known, el.version || 0));
    }
    if (msg.files && Object.keys(msg.files).length) {
      try { excaliAPI.addFiles(Object.values(msg.files)); } catch {}
    }
    if (changed) {
      try { excaliAPI.updateScene({ elements: [...byId.values()], commitToHistory: false }); } catch {}
      collabDirty = true; // para que el autoguardado persista lo convergido
    }
  }

  // Cambios locales → difundir SOLO los elementos con versión nueva (throttle
  // con cola: nunca se pierde el último estado).
  function onLocalChange(elements, _appState, files) {
    if (!collabReady) return;
    let dirty = false;
    for (const el of elements) {
      if ((syncedVersions.get(el.id) || 0) < (el.version || 0)) { dirty = true; break; }
    }
    if (!dirty) return;
    collabDirty = true;
    if (sceneSendTimer) return;
    const elapsed = Date.now() - sceneSendTs;
    sceneSendTimer = setTimeout(() => {
      sceneSendTimer = null;
      sceneSendTs = Date.now();
      if (!excaliAPI || !collabReady) return;
      const all = excaliAPI.getSceneElementsIncludingDeleted
        ? excaliAPI.getSceneElementsIncludingDeleted()
        : excaliAPI.getSceneElements();
      const changedEls = all.filter((el) => (syncedVersions.get(el.id) || 0) < (el.version || 0));
      if (!changedEls.length) return;
      for (const el of changedEls) syncedVersions.set(el.id, el.version || 0);
      wsSend({ type: "scene", elements: changedEls, files: excaliAPI.getFiles ? excaliAPI.getFiles() : undefined });
    }, Math.max(0, 120 - elapsed));
  }

  function onPointerUpdate(payload) {
    if (!collabReady) return;
    const now = Date.now();
    if (now - pointerTs < 50) return; // ~20 msgs/s máx
    pointerTs = now;
    wsSend({ type: "pointer", pointer: payload.pointer, button: payload.button });
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
          <span id="drawPresence" class="drawPresence" hidden></span>
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
      // Semilla anti-eco: lo cargado de S3 ya está "sincronizado" — sin esto, el
      // primer onChange difundiría la escena completa a la sala.
      syncedVersions.clear();
      for (const el of initialData?.elements || []) syncedVersions.set(el.id, el.version || 0);
      excaliRoot = window.ReactDOM.createRoot(host);
      excaliRoot.render(window.React.createElement(window.ExcalidrawLib.Excalidraw, {
        langCode: "es-ES",
        initialData,
        excalidrawAPI: (api) => { excaliAPI = api; },
        onChange: onLocalChange,
        onPointerUpdate,
      }));
      // Sala en vivo + autoguardado (cada 20s, solo si hubo cambios): la escena
      // convergida queda persistida en S3 sin depender del botón Guardar.
      joinCollab(drawing);
      autosaveTimer = setInterval(() => {
        if (collabDirty && excaliAPI && state.drawView === "editor" && state.drawActive?.id === drawing.id) {
          collabDirty = false;
          saveScene(drawing, true);
        }
      }, 20000);
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

  async function saveScene(drawing, silent = false) {
    if (!excaliAPI || !window.ExcalidrawLib) return;
    const statusEl = document.querySelector("#drawEditorStatus");
    const saveBtn = silent ? null : document.querySelector("#drawSaveBtn");
    const show = (text, isError) => {
      if (silent || !statusEl) return;
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
      setTimeout(() => { if (statusEl && !silent) statusEl.hidden = true; }, 2500);
    } catch (error) {
      if (silent) { collabDirty = true; return; } // reintentará el próximo autosave
      show(error.message, true);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Guardar"; }
    }
  }

  return { render };
}
