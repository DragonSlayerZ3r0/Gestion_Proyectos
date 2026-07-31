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

  // ── Pantalla completa del tablero (2026-07-31) ────────────────────────────
  // La clase vive en el SHELL (`#app`, igual que `.loginOnly`), NO en el panel
  // del editor: el modo tiene que sobrevivir a cualquier redibujado del panel, y
  // colgándolo del shell no depende de que el editor siga siendo el mismo nodo.
  // (Desde 2026-07-31 abrir «Compartir» o invitar ya NO redibujan el panel —
  // ver paintSharePanel—, pero la clase se queda en el shell igual: es la única
  // forma de esconder el menú lateral y el encabezado, que están fuera del panel.)
  // Además se pide la pantalla completa REAL del navegador cuando existe; en
  // iPhone la API no aplica a elementos que no sean <video>, así que ahí queda
  // el modo inmersivo — que es la mayor parte de lo que se gana (menú lateral y
  // encabezado de la app).
  function drawShell() {
    return document.querySelector("#app");
  }

  function isImmersive() {
    return !!drawShell()?.classList.contains("drawImmersive");
  }

  function setImmersive(on) {
    drawShell()?.classList.toggle("drawImmersive", on);
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    syncImmersiveButton();
    notifyCanvasResize(true);
  }

  // Excalidraw NO observa el tamaño de su contenedor: se remide con el evento
  // `resize` de la VENTANA. Cualquier cosa que cambie el alto del host —entrar o
  // salir de pantalla completa, abrir o cerrar el panel Compartir— tiene que
  // avisárselo, o el lienzo se queda con la medida anterior: se desborda por
  // abajo (invisible, lo tapa el overflow) y el puntero queda desfasado de lo
  // que se ve. Medido: canvas de 526px dentro de un host de 431px.
  function notifyCanvasResize(afterTransition) {
    // El aviso NO puede salir en el mismo tick que el cambio de DOM: dentro de un
    // `requestAnimationFrame` el navegador todavía no aplicó el layout nuevo y
    // Excalidraw remide el alto VIEJO (probado: el desfase seguía igual). Por eso
    // va en la siguiente macrotarea, cuando el alto del host ya es el definitivo.
    setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
    // Al entrar o salir de pantalla completa hay que esperar además a que termine
    // la transición del menú lateral (260ms), que es la que va moviendo el ancho.
    if (afterTransition) setTimeout(() => window.dispatchEvent(new Event("resize")), 320);
  }

  function syncImmersiveButton() {
    const button = document.querySelector("#drawFullBtn");
    if (!button) return;
    const on = isImmersive();
    // Fuera: solo el ícono — la barra ya lleva Volver/Compartir/Guardar y en el
    // teléfono cada palabra empuja una fila más, que se le resta al lienzo.
    // Dentro: con texto, porque sin barras del navegador la salida tiene que
    // ser evidente (regla docs/06: nada esencial detrás de un gesto).
    button.textContent = on ? "⛶ Salir" : "⛶";
    button.title = on ? "Salir de pantalla completa (Esc)" : "Pantalla completa";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // El usuario puede salir por su cuenta (Esc, F11, gesto del sistema): hay que
  // devolverle el layout normal o quedaría sin menú ni encabezado.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && isImmersive()) setImmersive(false);
  });
  // Esc cuando NO hay pantalla completa real (iPhone o navegador sin la API).
  // Sin `capture`: si Excalidraw usa Esc para deseleccionar, corre primero.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isImmersive() && !document.fullscreenElement) setImmersive(false);
  });

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

  // Devuelve si el mensaje SALIÓ: quien difunde elementos lo usa para no darlos
  // por sincronizados cuando no se mandaron (antes se marcaban igual y el cambio
  // no se reintentaba nunca).
  function wsSend(payload) {
    if (collabReady && collabSocket?.readyState === WebSocket.OPEN) {
      try {
        collabSocket.send(JSON.stringify(payload));
        return true;
      } catch {}
    }
    return false;
  }

  // API Gateway corta el mensaje en 128 KB (y el frame en 32 KB): un envío
  // pasado de tamaño se pierde ENTERO y en silencio. Los elementos se mandan en
  // tandas que quepan; el margen cubre los campos que agrega el servidor
  // (senderId/senderName/senderConn) y los caracteres multibyte del texto.
  const WS_MAX_CHARS = 90 * 1024;

  function sendElements(base, elements, onSent) {
    let batch = [];
    let size = 0;
    const flush = () => {
      if (!batch.length) return;
      if (wsSend({ ...base, elements: batch }) && onSent) onSent(batch);
      batch = [];
      size = 0;
    };
    for (const el of elements) {
      const elSize = JSON.stringify(el).length;
      if (batch.length && size + elSize > WS_MAX_CHARS) flush();
      batch.push(el);
      size += elSize;
    }
    flush();
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

  // ── Imágenes de la escena ─────────────────────────────────────────────────
  // El base64 de una imagen NO cabe en un mensaje del WebSocket. Hasta el
  // 2026-07-31 viajaba dentro del propio mensaje `scene` (`files: getFiles()`) y
  // el envío moría en silencio: a los demás les llegaba el ELEMENTO —que solo
  // trae el `fileId`— pero nunca el archivo, y Excalidraw dibuja eso como un
  // RECUADRO GRIS. Ahora cada imagen sube a S3 con URL prefirmada (igual que la
  // escena, sin pasar por la Lambda) y por el socket viaja solo el `fileId`.
  //
  // Se resuelve por RECONCILIACIÓN, no por aviso: si a un navegador le llega un
  // elemento con un `fileId` que no tiene, lo baja — sin importar si alcanzó a
  // oír el aviso. Así también lo ve quien estaba desconectado en ese momento o
  // quien entra después (mismo criterio que la reconciliación de elementos).
  const knownFiles = new Set();    // fileIds que este navegador ya tiene o subió
  const fetchingFiles = new Set(); // descargas en curso (no pedir dos veces lo mismo)

  function shareNewFiles(files) {
    const drawingId = state.drawActive?.id;
    if (!drawingId) return;
    for (const [fileId, file] of Object.entries(files || {})) {
      // Se marca ANTES de subir: si no, cada `onChange` mientras sube la
      // encolaría de nuevo. Y quien la RECIBE también la marca, para no
      // devolverla a S3 en cuanto Excalidraw le avise del cambio.
      if (!fileId || knownFiles.has(fileId)) continue;
      knownFiles.add(fileId);
      uploadFile(drawingId, fileId, file);
    }
  }

  // Se sube aunque la sala en vivo esté caída: el archivo tiene que estar en S3
  // para quien abra la pizarra después. El aviso por el socket es lo opcional.
  async function uploadFile(drawingId, fileId, file) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const presign = await apiRequest(
          `api/draw/${drawingId}/files/${encodeURIComponent(fileId)}/save-url`, { method: "POST" });
        const put = await fetch(presign.data.url, {
          method: "PUT",
          headers: { "content-type": presign.data.contentType },
          body: JSON.stringify(file),
        });
        if (!put.ok) throw new Error(`El almacenamiento respondió ${put.status}.`);
        wsSend({ type: "file", fileId });
        return true;
      } catch {
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    // Falló de verdad: el usuario tiene que enterarse. La imagen NO se pierde
    // (se guarda dentro de la escena), pero los demás no la verán en vivo.
    showEditorStatus("No se pudo compartir una imagen en vivo. Queda guardada en la pizarra: "
      + "los demás la verán al volver a abrirla.", true);
    return false;
  }

  function requestFile(fileId) {
    if (!fileId || !excaliAPI || !collabDrawingId) return;
    if (fetchingFiles.has(fileId)) return;
    const have = excaliAPI.getFiles ? excaliAPI.getFiles() : {};
    if (have[fileId]) return;
    fetchingFiles.add(fileId);
    downloadFile(collabDrawingId, fileId);
  }

  function ensureFiles(elements) {
    for (const el of elements || []) {
      if (el?.fileId) requestFile(el.fileId);
    }
  }

  // Esperas crecientes: el elemento puede llegar ANTES de que termine de subirse
  // su archivo (van por caminos distintos), así que un 404 no es un fracaso —
  // es "todavía no".
  async function downloadFile(drawingId, fileId) {
    const waits = [0, 400, 1000, 2000, 4000, 8000];
    for (const wait of waits) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (collabDrawingId !== drawingId || !excaliAPI) break; // se cerró la pizarra
      try {
        const presign = await apiRequest(`api/draw/${drawingId}/files/${encodeURIComponent(fileId)}/url`);
        const response = await fetch(presign.data.url);
        if (!response.ok) continue;
        const file = await response.json();
        addFile(fileId, file);
        fetchingFiles.delete(fileId);
        return;
      } catch {}
    }
    // Última carta: la escena guardada TAMBIÉN lleva las imágenes dentro. Ahí
    // viven las de antes de este cambio (que nunca se subieron sueltas) y ahí
    // acaba también la que no se haya podido subir.
    const fromScene = (await loadSceneFiles(drawingId))[fileId];
    if (fromScene) addFile(fileId, fromScene);
    fetchingFiles.delete(fileId);
  }

  function addFile(fileId, file) {
    if (!excaliAPI) return;
    knownFiles.add(fileId); // ya es mío: no devolverlo a S3 en el próximo onChange
    try { excaliAPI.addFiles([file]); } catch {}
  }

  // Una sola descarga de la escena aunque falten varias imágenes a la vez.
  let sceneFilesPromise = null;
  function loadSceneFiles(drawingId) {
    if (!sceneFilesPromise) {
      sceneFilesPromise = (async () => {
        if (state.drawActive?.id !== drawingId) return {};
        const scene = await loadScene(state.drawActive);
        return scene?.files || {};
      })().catch(() => ({})).finally(() => { sceneFilesPromise = null; });
    }
    return sceneFilesPromise;
  }

  function showEditorStatus(text, isError) {
    const statusEl = document.querySelector("#drawEditorStatus");
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = `attachStatus${isError ? " error" : ""}`;
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
    knownFiles.clear();
    fetchingFiles.clear();
    pendingScenes.length = 0;
    pendingInitFor.length = 0;
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
        // Un recién llegado necesita la escena: se la mando directo (vía servidor),
        // en tandas por tamaño y SIN archivos — las imágenes las baja él de S3
        // por su fileId (una escena con imágenes no cabía en un solo mensaje, así
        // que antes el recién llegado se quedaba sin nada).
        if (excaliAPI) {
          sendElements({ type: "init-response", to: msg.from }, excaliAPI.getSceneElements());
        } else if (msg.from) {
          pendingInitFor.push(msg.from); // todavía montando: se le responde al terminar
        }
        break;
      case "file":
        // Aviso de que hay una imagen nueva en S3. Es solo un atajo: si el aviso
        // se pierde, igual se baja al reconciliar el elemento que la usa.
        requestFile(msg.fileId);
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

  // Lo que llega de la sala puede llegar ANTES de que Excalidraw termine de
  // montar: el saludo de la sala y el montaje corren en paralelo. Antes se
  // descartaba en silencio y nadie lo volvía a mandar — el recién llegado se
  // quedaba con la pizarra VACÍA (medido: su `init-response` llegaba con el
  // editor a medio montar). Ahora se guarda y se aplica al terminar de montar.
  const pendingScenes = [];   // escenas recibidas antes de tiempo
  const pendingInitFor = [];  // quiénes me pidieron la escena antes de tiempo

  function flushPending() {
    if (!excaliAPI) return;
    for (const msg of pendingScenes.splice(0)) applyRemoteScene(msg);
    for (const to of pendingInitFor.splice(0)) {
      sendElements({ type: "init-response", to }, excaliAPI.getSceneElements());
    }
  }

  // Reconciliación: por elemento gana la versión mayor (a igual versión, el
  // versionNonce menor — mismo criterio que Excalidraw). Nada se interpreta:
  // los borrados viajan como isDeleted=true.
  function applyRemoteScene(msg) {
    if (!excaliAPI) {
      if (pendingScenes.length < 200) pendingScenes.push(msg);
      return;
    }
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
    // `files` en el mensaje ya no se usa (las imágenes van por S3), pero se
    // sigue aceptando: durante un despliegue puede quedar alguna pestaña vieja
    // difundiendo a la manera anterior.
    if (msg.files && Object.keys(msg.files).length) {
      try {
        for (const id of Object.keys(msg.files)) knownFiles.add(id);
        excaliAPI.addFiles(Object.values(msg.files));
      } catch {}
    }
    if (changed) {
      try { excaliAPI.updateScene({ elements: [...byId.values()], commitToHistory: false }); } catch {}
      collabDirty = true; // para que el autoguardado persista lo convergido
    }
    // Imágenes que este navegador todavía no tiene: se bajan de S3. Va DESPUÉS
    // de updateScene para no retrasar el dibujo del resto de la escena.
    ensureFiles(remote);
  }

  // Cambios locales → difundir SOLO los elementos con versión nueva (throttle
  // con cola: nunca se pierde el último estado).
  function onLocalChange(elements, _appState, files) {
    // Las imágenes nuevas suben a S3 SIEMPRE, aunque la sala esté caída: tienen
    // que estar ahí para quien abra la pizarra después.
    shareNewFiles(files);
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
      // Solo se dan por sincronizados los que SALIERON (y por tanda: si una no
      // sale, sus elementos se reintentan en el siguiente cambio).
      sendElements({ type: "scene" }, changedEls, (sent) => {
        for (const el of sent) syncedVersions.set(el.id, el.version || 0);
      });
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
    // Salir del editor («← Volver») devuelve el layout completo: quedarse en
    // pantalla completa sobre la LISTA dejaría al usuario sin menú ni salida.
    if (isImmersive()) setImmersive(false);
    unmountEditor();
    // La lista se REFRESCA en cada entrada (al abrir el módulo o volver del
    // editor): las INVITACIONES pendientes llegan aquí — con la carga única
    // cacheada de antes, un invitado que ya había visitado Pizarra no veía la
    // invitación hasta recargar la página completa (bug 2026-07-08).
    const firstLoad = !state.drawData;
    if (firstLoad && !state.drawError) {
      elements.contentPanel.innerHTML = `<section class="panel"><p class="emptyText">Cargando pizarras…</p></section>`;
    } else {
      renderList(); // pinta lo que hay YA; lo fresco repinta al llegar (sin "Cargando")
    }
    try {
      const payload = await apiRequest("api/draw");
      state.drawData = payload.data;
      state.drawError = "";
    } catch (error) {
      if (firstLoad) state.drawError = error.message; // con datos previos, se conservan
    }
    // Solo repintar si el usuario sigue en la LISTA de Pizarra (pudo navegar
    // a otro módulo o abrir una pizarra mientras cargaba).
    startListPoll();
    if (state.activeModule !== "draw" || state.drawView === "editor") return;
    renderList();
  }

  // Sondeo de la lista mientras el usuario está PARADO en ella: las invitaciones
  // aparecen solas (~10 s) sin refrescar la página. Barato y educado: solo corre
  // con el módulo activo en vista lista y la pestaña visible, y únicamente
  // repinta si algo cambió (comparación por JSON — no molesta al que escribe).
  let listPollTimer = null;
  function startListPoll() {
    if (listPollTimer) return;
    listPollTimer = window.setInterval(async () => {
      if (state.activeModule !== "draw" || state.drawView === "editor" || document.hidden) return;
      try {
        const payload = await apiRequest("api/draw");
        if (JSON.stringify(payload.data) === JSON.stringify(state.drawData)) return;
        state.drawData = payload.data;
        if (state.activeModule !== "draw" || state.drawView === "editor") return;
        // Preservar lo tecleado en "Nueva pizarra" si el repintado llega justo ahí.
        const input = document.querySelector("#drawCreateForm input[name='name']");
        const draft = input && document.activeElement === input ? input.value : null;
        renderList();
        if (draft !== null) {
          const fresh = document.querySelector("#drawCreateForm input[name='name']");
          if (fresh) { fresh.value = draft; fresh.focus(); }
        }
      } catch {}
    }, 10000);
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
    return d.toLocaleDateString("es-GT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala" });
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
            <button class="tinyButton ghost drawFullBtn" type="button" id="drawFullBtn"></button>
            ${isOwner ? `<button class="tinyButton ghost" type="button" id="drawShareBtn" aria-expanded="false">Compartir</button>` : ""}
            <button class="primaryButton compact" type="button" id="drawSaveBtn">Guardar</button>
          </div>
        </div>
        <div id="drawShareHost" class="drawShareHost"></div>
        <p id="drawEditorStatus" class="attachStatus" role="status" hidden></p>
        <div id="drawEditorHost" class="drawEditorHost"><p class="emptyText drawLoadingHint">Cargando el editor…</p></div>
      </section>`;
    bindEditorEvents(drawing, isOwner);
    // El botón se rotula acá (una sola fuente de verdad), para que conserve su
    // estado cada vez que se dibuja el panel del editor.
    syncImmersiveButton();
    paintSharePanel(drawing, isOwner);
    await mountExcalidraw(drawing);
  }

  // El panel Compartir tiene CONTENEDOR PROPIO y se pinta solo — abrirlo, cerrarlo,
  // invitar o revocar NUNCA repinta el editor. Antes llamaban a renderEditor(), que
  // reescribe el panel entero: eso desmontaba Excalidraw y lo remontaba desde la
  // escena de S3, o sea que se perdía todo lo que el autoguardado (cada 20 s) aún
  // no había subido — y en una pizarra RECIÉN CREADA no hay escena en S3 todavía,
  // así que el lienzo volvía vacío: se perdía el dibujo completo. De paso reciclaba
  // el socket de la sala en vivo (leave+join para los demás) y recargaba ~1 MB de
  // escena. Bug preexistente corregido el 2026-07-31.
  function paintSharePanel(drawing, isOwner) {
    const host = document.querySelector("#drawShareHost");
    if (!host) return;
    const open = Boolean(state.drawShareOpen && isOwner);
    host.innerHTML = open ? sharePanelHtml(drawing) : "";
    document.querySelector("#drawShareBtn")?.setAttribute("aria-expanded", String(open));
    if (open) bindShareEvents(host, drawing, isOwner);
    // El panel le quita (o le devuelve) alto al lienzo: hay que avisarle.
    notifyCanvasResize();
  }

  function sharePanelHtml(drawing) {
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
    document.querySelector("#drawBackBtn")?.addEventListener("click", async (event) => {
      // Salir es un punto de PÉRDIDA: desmontar destruye la API de Excalidraw y
      // con ella lo que no alcanzó a subir el autoguardado. Se persiste ANTES de
      // desmontar; si el guardado falla, el usuario decide si sale igual.
      const backBtn = event.currentTarget;
      backBtn.disabled = true;
      backBtn.textContent = "Guardando…";
      const saved = await saveScene(drawing, true);
      backBtn.disabled = false;
      backBtn.textContent = "← Volver";
      if (!saved && !window.confirm("No se pudo guardar la pizarra. ¿Salir de todos modos? Se perderán los últimos cambios.")) return;
      state.drawView = "list";
      state.drawActive = null;
      state.drawShareOpen = false;
      unmountEditor();
      render();
    });
    document.querySelector("#drawFullBtn")?.addEventListener("click", () => setImmersive(!isImmersive()));
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
      paintSharePanel(drawing, isOwner);
    });
  }

  // Eventos del panel Compartir: se revinculan en CADA pintada del panel (su HTML
  // se rehace al invitar o revocar), acotados a su contenedor.
  function bindShareEvents(host, drawing, isOwner) {
    host.querySelector("#drawShareInvite")?.addEventListener("click", async () => {
      const select = host.querySelector("#drawShareSelect");
      const email = select?.value || "";
      if (!email) return;
      try {
        const payload = await apiRequest(`api/draw/${drawing.id}/shares`, { method: "POST", body: JSON.stringify({ email }) });
        const person = (state.drawPeople || []).find((p) => p.email === email);
        drawing.shares.push({ ...payload.data, userName: person?.name || email });
        paintSharePanel(drawing, isOwner);
      } catch (error) {
        alert(error.message);
      }
    });
    for (const btn of host.querySelectorAll("[data-draw-revoke]")) {
      btn.addEventListener("click", async () => {
        const email = btn.dataset.drawRevoke;
        if (!window.confirm("¿Quitar el acceso de este usuario a la pizarra?")) return;
        try {
          await apiRequest(`api/draw/${drawing.id}/shares/${encodeURIComponent(email)}`, { method: "DELETE" });
          drawing.shares = drawing.shares.filter((s) => s.userId !== email);
          paintSharePanel(drawing, isOwner);
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
      // Las imágenes que ya venían DENTRO de la escena no se vuelven a subir:
      // todo el que abra la pizarra las recibe con ella (esto incluye las de
      // antes del cambio, que solo existen ahí).
      knownFiles.clear();
      fetchingFiles.clear();
      for (const id of Object.keys(initialData?.files || {})) knownFiles.add(id);
      excaliRoot = window.ReactDOM.createRoot(host);
      excaliRoot.render(window.React.createElement(window.ExcalidrawLib.Excalidraw, {
        langCode: "es-ES",
        initialData,
        // El vaciado va en la macrotarea siguiente: Excalidraw entrega su API
        // MIENTRAS monta, y un `updateScene` en ese mismo tick se pierde
        // (medido: al recién llegado le entraba el archivo pero no el elemento).
        excalidrawAPI: (api) => { excaliAPI = api; setTimeout(flushPending, 0); },
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

  // Devuelve si el trabajo quedó A SALVO (true también cuando no hay nada que
  // guardar): quien sale del editor lo usa para no desmontar a ciegas.
  async function saveScene(drawing, silent = false) {
    if (!excaliAPI || !window.ExcalidrawLib) return true;
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
      return true;
    } catch (error) {
      if (silent) { collabDirty = true; return false; } // reintentará el próximo autosave
      show(error.message, true);
      return false;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Guardar"; }
    }
  }

  return { render };
}
