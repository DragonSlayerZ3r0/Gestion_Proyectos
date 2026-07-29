// @ts-nocheck
// Línea de tiempo de una solicitud (2026-07-28).
//
// Portado del proyecto hermano `pry_timeline` (mismo autor): el diagrama es DOM
// + CSS puro — sin librerías ni SVG — así que encaja en el frontend vanilla de
// esta plataforma sin sumar peso ni dependencias externas (regla del proyecto).
//
// DIFERENCIA CLAVE con el original: allá los hitos se capturan a mano; aquí se
// DERIVAN de datos que el equipo ya mantiene — cada TAREA es un hito, ordenado
// por su fecha, con su estado/avance/responsable, y sus seguimientos aparecen
// como actividades anidadas. Cero captura extra: si el tablero está al día, el
// diagrama también.
//
// Se abre en un modal casi a pantalla completa (NO en otra pestaña: la sesión
// Cognito vive en sessionStorage, que es por pestaña — una pestaña nueva pediría
// iniciar sesión otra vez).
export function createTimelineModule(ctx) {
  const { state, escapeHtml, escapeAttribute } = ctx;

  const STATUS_CLASS = {
    done: "done",
    in_progress: "progress",
    review: "review",
    pending: "pending",
  };

  function taskStatusLabel(key) {
    return (state.workspace?.taskStatuses || []).find((s) => s.key === key)?.label || "Pendiente";
  }

  function personName(peopleById, personId) {
    return peopleById?.[personId]?.fullName || "";
  }

  // "2026-07-31" → "31 jul 2026" (fecha del dato, sin hora: se formatea fija en
  // hora de Guatemala como el resto de la app).
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(`${iso}T12:00:00`);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("es-GT", { day: "numeric", month: "short", year: "numeric" });
  }

  // ── Mapeo solicitud → hitos ─────────────────────────────────────────────────
  // Orden: por la fecha que mejor ubica a la tarea en el tiempo (fin, si no
  // inicio). Las tareas SIN fecha van al final en su orden original — no se
  // inventan fechas ni se esconden: se muestran como "Sin fecha", que es
  // información útil (algo pendiente de planificar).
  function buildMilestones(project) {
    const tasks = [...(project.tasks || [])];
    const key = (t) => t.endDate || t.startDate || "";
    const withDate = tasks.filter((t) => key(t));
    const withoutDate = tasks.filter((t) => !key(t));
    withDate.sort((a, b) => key(a).localeCompare(key(b)));
    return [...withDate, ...withoutDate];
  }

  function progressOf(project) {
    if (project.progress !== "" && project.progress !== undefined && project.progress !== null) {
      return { pct: Number(project.progress), source: "manual" };
    }
    const tasks = project.tasks || [];
    if (!tasks.length) return { pct: null, source: "none" };
    const total = tasks.reduce((sum, t) => {
      if (t.progress !== "" && t.progress !== undefined && t.progress !== null) return sum + Number(t.progress);
      return sum + (t.status === "done" ? 100 : 0);
    }, 0);
    return { pct: Math.round(total / tasks.length), source: "tareas" };
  }

  // ── Render del diagrama ─────────────────────────────────────────────────────
  function activitiesHtml(task) {
    const updates = (task.updates || []).slice(0, 4);   // los más recientes
    if (!updates.length) return "";
    const rows = updates.map((u) => `
      <div class="tlActivity">
        <span class="tlActivityLabel">${u.date ? `${escapeHtml(fmtDate(u.date))} · ` : ""}${escapeHtml(u.text)}</span>
      </div>`).join("");
    const more = (task.updates || []).length - updates.length;
    return `<div class="tlActivityList">${rows}${
      more > 0 ? `<span class="tlActivityMore">+${more} seguimiento${more === 1 ? "" : "s"} más</span>` : ""
    }</div>`;
  }

  function milestoneHtml(task, index, peopleById) {
    const date = task.endDate || task.startDate || "";
    const pct = task.progress !== "" && task.progress !== undefined && task.progress !== null
      ? Number(task.progress)
      : (task.status === "done" ? 100 : 0);
    const who = personName(peopleById, task.assigneePersonId);
    const cls = STATUS_CLASS[task.status] || "pending";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Guatemala" });
    const overdue = task.endDate && task.endDate < today && task.status !== "done";
    return `
      <article class="tlItem is-${cls}">
        <div class="tlMarker">${index + 1}</div>
        <div class="tlContent">
          <span class="tlDate${overdue ? " isOverdue" : ""}">${
            date ? escapeHtml(fmtDate(date)) : "Sin fecha"}${overdue ? " · vencida" : ""}</span>
          <h3>${escapeHtml(task.title)}</h3>
          <div class="tlMeta">
            <span class="tlBadge is-${cls}">${escapeHtml(taskStatusLabel(task.status))}</span>
            ${who ? `<span class="tlWho">${escapeHtml(who)}</span>` : ""}
          </div>
          <div class="tlProgress"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
          <span class="tlProgressPct">${pct}%</span>
          ${activitiesHtml(task)}
        </div>
      </article>`;
  }

  function diagramHtml(project, peopleById) {
    const milestones = buildMilestones(project);
    if (!milestones.length) {
      return `<div class="tlEmpty">
        <strong>Esta solicitud aún no tiene tareas</strong>
        <span>Crea tareas con sus fechas y aquí se dibuja la línea de tiempo automáticamente.</span>
      </div>`;
    }
    return `<div class="tlTrack">${milestones.map((t, i) => milestoneHtml(t, i, peopleById)).join("")}</div>`;
  }

  function summaryHtml(project) {
    const { pct, source } = progressOf(project);
    const milestones = buildMilestones(project);
    return `
      <div class="tlSummary">
        <!-- El nombre de la solicitud NO se repite aquí: ya es el título del
             modal (evitar redundancia = menos ruido, docs/06). -->
        <div><span class="tlSummaryLabel">Inicio</span><strong>${project.requestDate ? escapeHtml(fmtDate(project.requestDate)) : "Sin fecha"}</strong></div>
        <div><span class="tlSummaryLabel">Entrega</span><strong>${project.dueDate ? escapeHtml(fmtDate(project.dueDate)) : "Sin fecha"}</strong></div>
        <div><span class="tlSummaryLabel">Hitos</span><strong>${milestones.length}</strong></div>
        <div class="tlSummaryProgress">
          <span class="tlSummaryLabel">Avance${source === "tareas" ? " (por tareas)" : source === "manual" ? "" : ""}</span>
          <strong>${pct === null ? "—" : `${pct}%`}</strong>
          <div class="tlProgress big"><span style="width:${pct === null ? 0 : pct}%"></span></div>
        </div>
      </div>`;
  }

  // ── Modal ───────────────────────────────────────────────────────────────────
  function open(project, peopleById) {
    if (!project) return;
    const modal = document.createElement("div");
    modal.className = "tlModal";
    modal.innerHTML = `
      <div class="tlDialog" role="dialog" aria-label="Línea de tiempo de la solicitud">
        <div class="tlHead">
          <div>
            <p class="eyebrow">Línea de tiempo</p>
            <h3>${escapeHtml(project.name || "Sin nombre")}</h3>
          </div>
          <div class="tlHeadActions">
            <div class="tlOrientation" role="group" aria-label="Orientación del diagrama">
              <button type="button" class="tlOrientBtn active" data-tl-orient="horizontal" aria-pressed="true">↔ Horizontal</button>
              <button type="button" class="tlOrientBtn" data-tl-orient="vertical" aria-pressed="false">↕ Vertical</button>
            </div>
            <button type="button" class="tinyButton" data-tl-present title="Ver a pantalla completa para presentar">⛶ Presentar</button>
            <button type="button" class="tinyButton" data-tl-pdf title="Abre el diálogo de impresión: elige «Guardar como PDF»">⬇ PDF</button>
            <button type="button" class="tlClose" aria-label="Cerrar">×</button>
          </div>
        </div>
        ${summaryHtml(project)}
        <div class="tlStage" data-tl-stage data-orientation="horizontal">${diagramHtml(project, peopleById)}</div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector(".tlClose").onclick = close;
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.tabIndex = -1;
    modal.focus();
    modal.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    const stage = modal.querySelector("[data-tl-stage]");
    for (const btn of modal.querySelectorAll("[data-tl-orient]")) {
      btn.addEventListener("click", () => {
        const orient = btn.dataset.tlOrient;
        stage.dataset.orientation = orient;
        for (const b of modal.querySelectorAll("[data-tl-orient]")) {
          const on = b === btn;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
      });
    }

    // Presentar: pantalla completa REAL sobre el diálogo (sin barras del sistema
    // ni de la app). Si el navegador la bloquea, el modal sigue siendo usable.
    modal.querySelector("[data-tl-present]").addEventListener("click", () => {
      const dialog = modal.querySelector(".tlDialog");
      if (document.fullscreenElement) document.exitFullscreen?.();
      else dialog.requestFullscreen?.().catch(() => {});
    });

    modal.querySelector("[data-tl-pdf]").addEventListener("click", () => printTimeline(project, peopleById));
  }

  // PDF por impresión nativa (mismo criterio que el Reporte ejecutivo: texto
  // seleccionable, sin librerías). El diagrama se imprime SIEMPRE en vertical:
  // en una hoja, el recorrido de arriba a abajo es el que no se corta.
  function printTimeline(project, peopleById) {
    const now = new Date().toLocaleString("es-GT", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala",
    });
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="es"><head><meta charset="utf-8" />
      <title>Línea de tiempo — ${escapeHtml(project.name || "Solicitud")}</title>
      <style>
        @page { size: A4; margin: 16mm 14mm; }
        * { box-sizing: border-box; }
        body { margin: 0; font: 10.5pt/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1c2528; }
        header { border-bottom: 2px solid #2f6f63; padding-bottom: 8px; margin-bottom: 14px; }
        header h1 { margin: 0 0 3px; font-size: 15pt; color: #14322c; }
        header .meta { font-size: 8.5pt; color: #5c6b70; }
        .sum { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 16px; font-size: 9pt; }
        .sum div { border: 1px solid #cfd8da; border-radius: 5px; padding: 6px 10px; }
        .sum span { display: block; color: #7b898e; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; }
        .sum strong { font-size: 10pt; color: #14322c; }
        .it { position: relative; padding: 0 0 12px 26px; border-left: 3px solid #cfe0dd; break-inside: avoid; }
        .it:last-child { border-left-color: transparent; }
        .it::before { content: ""; position: absolute; left: -8px; top: 2px; width: 13px; height: 13px;
                      border-radius: 50%; background: #2f6f63; border: 2px solid #fff; box-shadow: 0 0 0 1px #cfe0dd; }
        .it h3 { margin: 0 0 2px; font-size: 11pt; color: #14322c; }
        .d { font-size: 8pt; color: #8a5700; font-weight: 700; text-transform: uppercase; }
        .d.ov { color: #b91c1c; }
        .m { font-size: 8.5pt; color: #5c6b70; margin: 2px 0 4px; }
        .act { margin: 4px 0 0 6px; padding-left: 8px; border-left: 2px solid #f0d9a0; }
        .act div { font-size: 8.5pt; color: #40525a; margin: 2px 0; }
        footer { margin-top: 18px; padding-top: 7px; border-top: 1px solid #dfe6e7; font-size: 8pt; color: #7b898e; }
      </style></head><body>
      <header>
        <h1>Línea de tiempo — ${escapeHtml(project.name || "Solicitud")}</h1>
        <div class="meta">Gerencia Administrativa de Datos · ${escapeHtml(now)} (hora de Guatemala)</div>
      </header>
      ${printSummary(project)}
      ${printItems(project, peopleById)}
      <footer>Generado desde la plataforma con las tareas y seguimientos vigentes de la solicitud.</footer>
    </body></html>`);
    doc.close();
    const go = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { /* bloqueado */ }
      setTimeout(() => frame.remove(), 60000);
    };
    if (frame.contentWindow.document.readyState === "complete") requestAnimationFrame(go);
    else frame.onload = () => requestAnimationFrame(go);
  }

  function printSummary(project) {
    const { pct } = progressOf(project);
    const cells = [
      ["Inicio", project.requestDate ? fmtDate(project.requestDate) : "Sin fecha"],
      ["Entrega", project.dueDate ? fmtDate(project.dueDate) : "Sin fecha"],
      ["Hitos", String(buildMilestones(project).length)],
      ["Avance", pct === null ? "—" : `${pct}%`],
    ];
    return `<div class="sum">${cells.map(([k, v]) =>
      `<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join("")}</div>`;
  }

  function printItems(project, peopleById) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Guatemala" });
    return buildMilestones(project).map((t) => {
      const date = t.endDate || t.startDate || "";
      const overdue = t.endDate && t.endDate < today && t.status !== "done";
      const pct = t.progress !== "" && t.progress !== undefined && t.progress !== null
        ? Number(t.progress) : (t.status === "done" ? 100 : 0);
      const who = personName(peopleById, t.assigneePersonId);
      const acts = (t.updates || []).slice(0, 4).map((u) =>
        `<div>${u.date ? `${escapeHtml(fmtDate(u.date))} · ` : ""}${escapeHtml(u.text)}</div>`).join("");
      return `<div class="it">
        <span class="d${overdue ? " ov" : ""}">${date ? escapeHtml(fmtDate(date)) : "Sin fecha"}${overdue ? " · vencida" : ""}</span>
        <h3>${escapeHtml(t.title)}</h3>
        <div class="m">${escapeHtml(taskStatusLabel(t.status))} · ${pct}%${who ? ` · ${escapeHtml(who)}` : ""}</div>
        ${acts ? `<div class="act">${acts}</div>` : ""}
      </div>`;
    }).join("");
  }

  return { open };
}
