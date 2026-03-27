import { initResizer } from "/resizer.js";
import {
  escapeHtml,
  renderSessionList,
  connectSessionChangeEvents,
  initAppMenu,
} from "/shared.js";

// Detect dark mode via JS and apply a class to <html> so SVG CSS overrides always work
const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
function syncDarkClass(e) {
  document.documentElement.classList.toggle("is-dark", e.matches);
}
syncDarkClass(darkMq);
darkMq.addEventListener("change", syncDarkClass);

const sessionListEl = document.getElementById("session-list");
const dataViewEl = document.getElementById("data-view");
const currentSessionEl = document.getElementById("current-session");
const tableSelectEl = document.getElementById("table-select");
const refreshTodosBtn = document.getElementById("refresh-todos");

let sessions = [];
let selectedSessionId = null;
let selectedTable = "";

function nodeStatusClass(status) {
  const s = status ? status.toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["done", "completed"].includes(s)) return "graph-node-done";
  if (["in_progress", "active"].includes(s)) return "graph-node-in-progress";
  if (["pending", "todo", "open"].includes(s)) return "graph-node-pending";
  if (["failed", "error", "blocked"].includes(s)) return "graph-node-blocked";
  return "graph-node-default";
}

const NODE_COLORS = {
  "graph-node-done": { fill: "#0e2018", stroke: "#2a6040" },
  "graph-node-in-progress": { fill: "#1e1800", stroke: "#705800" },
  "graph-node-pending": { fill: "#14161c", stroke: "#404858" },
  "graph-node-blocked": { fill: "#1e0a0e", stroke: "#702030" },
  "graph-node-default": { fill: "#0e1420", stroke: "#3a5070" },
};

function truncate(str, max) {
  const s = str || "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function wrapText(text, maxCharsPerLine, maxLines) {
  if (!text) return [""];
  const words = text.trim().split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (lines.length === maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines) {
    if (current) lines.push(current);
  } else if (current) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] =
      last.length < maxCharsPerLine
        ? last + "…"
        : last.slice(0, maxCharsPerLine - 1) + "…";
  }
  return lines.map((l) =>
    l.length > maxCharsPerLine ? l.slice(0, maxCharsPerLine - 1) + "…" : l,
  );
}

function renderDependencyGraph(todosRows, todoDepsRows) {
  if (!todoDepsRows || todoDepsRows.length === 0) return "";

  // Build info map from todos table (id → {title, status, description})
  const todoMap = new Map();
  if (todosRows) {
    for (const t of todosRows) {
      todoMap.set(String(t.id), {
        title: String(t.title || t.id || ""),
        status: String(t.status || ""),
        description: String(t.description || ""),
      });
    }
  }

  // Collect all node IDs from both columns of todo_deps
  const nodeIds = new Set();
  for (const dep of todoDepsRows) {
    nodeIds.add(String(dep.todo_id));
    nodeIds.add(String(dep.depends_on));
  }

  // Edge direction: depends_on → todo_id (prerequisite → dependent)
  const inEdges = new Map();
  const outEdges = new Map();
  for (const id of nodeIds) {
    inEdges.set(id, []);
    outEdges.set(id, []);
  }
  const edges = [];
  for (const dep of todoDepsRows) {
    const from = String(dep.depends_on);
    const to = String(dep.todo_id);
    if (from !== to) {
      outEdges.get(from)?.push(to);
      inEdges.get(to)?.push(from);
      edges.push({ from, to });
    }
  }

  // Assign ranks via longest-path from roots; break cycles by tracking in-progress nodes
  const rankMap = new Map();
  const inProgress = new Set();
  function computeRank(id) {
    if (rankMap.has(id)) return rankMap.get(id);
    if (inProgress.has(id)) return 0;
    inProgress.add(id);
    const preds = inEdges.get(id) || [];
    const r = preds.length === 0 ? 0 : Math.max(...preds.map(computeRank)) + 1;
    inProgress.delete(id);
    rankMap.set(id, r);
    return r;
  }
  for (const id of nodeIds) computeRank(id);

  // Group nodes by rank column
  const rankGroups = new Map();
  for (const [id, r] of rankMap) {
    if (!rankGroups.has(r)) rankGroups.set(r, []);
    rankGroups.get(r).push(id);
  }

  const NODE_W = 175;
  const NODE_H = 70;
  const H_GAP = 65;
  const V_GAP = 16;
  const PAD = 20;
  const LINE_H = 15;
  const MAX_TITLE_CHARS = 20;
  const MAX_TITLE_LINES = 2;

  const maxRank = Math.max(...rankMap.values());
  const maxNodesInRank = Math.max(
    ...Array.from(rankGroups.values()).map((g) => g.length),
  );
  const svgW = PAD * 2 + (maxRank + 1) * NODE_W + maxRank * H_GAP;
  const svgH =
    PAD * 2 + maxNodesInRank * NODE_H + Math.max(0, maxNodesInRank - 1) * V_GAP;

  // Position nodes, centering each rank column vertically within the SVG
  const positions = new Map();
  for (const [r, nodes] of rankGroups) {
    const colH = nodes.length * NODE_H + Math.max(0, nodes.length - 1) * V_GAP;
    const startY = PAD + (svgH - PAD * 2 - colH) / 2;
    for (let i = 0; i < nodes.length; i++) {
      positions.set(nodes[i], {
        x: PAD + r * (NODE_W + H_GAP),
        y: startY + i * (NODE_H + V_GAP),
      });
    }
  }

  const parts = [];

  // Arrowhead marker — color controlled by CSS via .graph-arrow class
  parts.push(`<defs>
    <marker id="tdg-arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon class="graph-arrow" points="0 0, 10 3.5, 0 7"/>
    </marker>
  </defs>`);

  // Edges (drawn below nodes) — color controlled by CSS via .graph-edge class
  for (const { from, to } of edges) {
    const fp = positions.get(from);
    const tp = positions.get(to);
    if (!fp || !tp) continue;
    const x1 = fp.x + NODE_W;
    const y1 = fp.y + NODE_H / 2;
    const x2 = tp.x;
    const y2 = tp.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    parts.push(
      `<path class="graph-edge" d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}" ` +
        `fill="none" stroke-width="1.5" marker-end="url(#tdg-arrow)"/>`,
    );
  }

  // Nodes — fill/stroke applied via inline style for reliable cross-browser rendering;
  // CSS classes retained for hover filter and font properties.
  for (const [id, pos] of positions) {
    const info = todoMap.get(id) ?? { title: id, status: "" };
    const sc = nodeStatusClass(info.status);
    const { fill, stroke } =
      NODE_COLORS[sc] ?? NODE_COLORS["graph-node-default"];
    const titleLines = wrapText(
      info.title || id,
      MAX_TITLE_CHARS,
      MAX_TITLE_LINES,
    );
    const statusLabel = info.status
      ? truncate(info.status.replace(/_/g, " "), 22)
      : "";
    const hasStatus = statusLabel.length > 0;
    const cx = pos.x + NODE_W / 2;

    // Vertical layout: centre title block + status within the node height
    const titleY =
      titleLines.length === 1
        ? pos.y + (hasStatus ? 24 : 35)
        : pos.y + (hasStatus ? 18 : 22);
    const statusY = pos.y + (titleLines.length === 1 ? 50 : 54);

    const descAttr = info.description
      ? ` data-description="${escapeHtml(info.description)}"`
      : "";
    const titleAttr = ` data-title="${escapeHtml(info.title || id)}"`;
    const statusAttr = info.status
      ? ` data-status="${escapeHtml(info.status)}"`
      : "";
    let g = `<g class="graph-node ${sc}" data-id="${escapeHtml(id)}"${titleAttr}${statusAttr}${descAttr}>`;
    g += `<rect x="${pos.x}" y="${pos.y}" width="${NODE_W}" height="${NODE_H}" rx="7" stroke-width="1.5" style="fill:gray;stroke:gray"/>`;
    g += `<text x="${cx}" y="${titleY}" text-anchor="middle" class="gn-title" style="fill:#dde4f0">`;
    for (let i = 0; i < titleLines.length; i++) {
      g += `<tspan x="${cx}" dy="${i === 0 ? 0 : LINE_H}">${escapeHtml(titleLines[i])}</tspan>`;
    }
    g += `</text>`;
    if (statusLabel) {
      g += `<text x="${cx}" y="${statusY}" text-anchor="middle" class="gn-status" style="fill:#8a9ab8">${escapeHtml(statusLabel)}</text>`;
    }
    g += `</g>`;
    parts.push(g);
  }

  return (
    `<div class="dependency-graph">` +
    `<h3>Dependency Graph</h3>` +
    `<div class="graph-scroll">` +
    `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">` +
    parts.join("\n") +
    `</svg></div></div>`
  );
}

let tooltipEl = null;
function getTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "graph-tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function positionTooltip(tip, e) {
  const pad = 14;
  tip.style.left = `${e.clientX + pad}px`;
  tip.style.top = `${e.clientY + pad}px`;
  // Clamp so it doesn't overflow the right/bottom edge
  const r = tip.getBoundingClientRect();
  if (r.right > window.innerWidth - pad) {
    tip.style.left = `${e.clientX - r.width - pad}px`;
  }
  if (r.bottom > window.innerHeight - pad) {
    tip.style.top = `${e.clientY - r.height - pad}px`;
  }
}

function attachGraphTooltips() {
  const tip = getTooltip();
  const svg = dataViewEl.querySelector(".graph-scroll svg");
  if (!svg) {
    tip.style.display = "none";
    return;
  }
  svg.addEventListener("mousemove", (e) => {
    const node = e.target.closest(".graph-node");
    const desc = node?.dataset.description;
    if (desc) {
      tip.textContent = desc;
      tip.style.display = "block";
      positionTooltip(tip, e);
    } else {
      tip.style.display = "none";
    }
  });
  svg.addEventListener("mouseleave", () => {
    tip.style.display = "none";
  });
  svg.addEventListener("click", (e) => {
    const node = e.target.closest(".graph-node");
    if (!node) return;
    const desc = node.dataset.description;
    if (!desc) return;
    tip.style.display = "none";
    showNodeModal(
      node.dataset.title || node.dataset.id || "",
      node.dataset.status || "",
      desc,
    );
  });
}

let modalEl = null;
function getModal() {
  if (!modalEl) {
    modalEl = document.createElement("div");
    modalEl.className = "node-modal-backdrop";
    modalEl.innerHTML = `
      <div class="node-modal" role="dialog" aria-modal="true">
        <div class="node-modal-header">
          <div class="node-modal-title-wrap">
            <span class="node-modal-title"></span>
            <span class="node-modal-status"></span>
          </div>
          <button class="node-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="node-modal-body"></div>
      </div>`;
    modalEl
      .querySelector(".node-modal-close")
      .addEventListener("click", closeModal);
    // Close on backdrop click
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeModal();
    });
    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modalEl.classList.contains("is-open"))
        closeModal();
    });
    document.body.appendChild(modalEl);
  }
  return modalEl;
}

function showNodeModal(title, status, description) {
  const modal = getModal();
  modal.querySelector(".node-modal-title").textContent = title;
  const statusEl = modal.querySelector(".node-modal-status");
  if (status) {
    statusEl.textContent = status.replace(/_/g, " ");
    statusEl.className = `node-modal-status status-badge ${statusClass(status)}`;
    statusEl.style.display = "";
  } else {
    statusEl.style.display = "none";
  }
  modal.querySelector(".node-modal-body").textContent = description;
  modal.classList.add("is-open");
}

function closeModal() {
  modalEl?.classList.remove("is-open");
}

function statusClass(value) {
  if (typeof value !== "string") return "";
  const normalized = value.toLowerCase().replace(/\s+/g, "_");
  const knownStatuses = [
    "done",
    "completed",
    "in_progress",
    "in-progress",
    "active",
    "pending",
    "todo",
    "open",
    "failed",
    "error",
    "blocked",
  ];
  if (knownStatuses.includes(normalized)) {
    return `status-${normalized}`;
  }
  return "";
}

function renderTable(tableName, rows) {
  if (!rows || rows.length === 0) {
    return `<div class="table-section"><h3>${escapeHtml(tableName)}</h3><p class="placeholder">No data in this table.</p></div>`;
  }
  const columns = Object.keys(rows[0]);
  let html = `<div class="table-section"><h3>${escapeHtml(tableName)}</h3>`;
  html += `<table class="data-table"><thead><tr>`;
  for (const col of columns) {
    html += `<th>${escapeHtml(col)}</th>`;
  }
  html += `</tr></thead><tbody>`;
  for (const row of rows) {
    html += `<tr>`;
    for (const col of columns) {
      const value = row[col];
      const display = value == null ? "" : String(value);
      const sc = statusClass(display);
      if (sc) {
        html += `<td><span class="status-badge ${sc}">${escapeHtml(display)}</span></td>`;
      } else {
        html += `<td>${escapeHtml(display)}</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

async function refreshSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) {
      console.error("Failed to load sessions: HTTP", res.status);
      sessions = [];
    } else {
      const data = await res.json();
      sessions = Array.isArray(data) ? data : [];
    }
  } catch (error) {
    console.error("Failed to load sessions:", error);
    sessions = [];
  }
  if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = null;
    selectedTable = "";
  }
  if (!selectedSessionId && sessions.length > 0) {
    selectedSessionId = sessions[0].id;
  }
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  if (selectedSessionId) {
    await loadSessionData(selectedSessionId);
  }
}

function updateTableSelect(tables) {
  tableSelectEl.innerHTML = '<option value="">All tables</option>';
  for (const table of tables) {
    const opt = document.createElement("option");
    opt.value = table;
    opt.textContent = table;
    tableSelectEl.appendChild(opt);
  }
  tableSelectEl.disabled = tables.length === 0;
  tableSelectEl.value = selectedTable;
}

async function loadSessionData(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      dataViewEl.innerHTML = `<p class="placeholder">Failed to load session data.</p>`;
      return;
    }
    const data = await res.json();
    currentSessionEl.textContent = data.title || data.directory;
    const tables = data.tables || [];
    updateTableSelect(tables);

    // Show dependency graph at the top whenever todo_deps table is present
    const hasGraph = tables.includes("todo_deps");
    const graphHtml = hasGraph
      ? renderDependencyGraph(data.data["todos"], data.data["todo_deps"])
      : "";

    if (selectedTable && data.data[selectedTable]) {
      // When the graph is shown, suppress the raw todo_deps table view
      const tableHtml =
        hasGraph && selectedTable === "todo_deps"
          ? ""
          : renderTable(selectedTable, data.data[selectedTable]);
      dataViewEl.innerHTML = graphHtml + tableHtml;
    } else if (!selectedTable) {
      let html = "";
      for (const table of tables) {
        // Skip todo_deps in the table list when the graph is already showing it
        if (hasGraph && table === "todo_deps") continue;
        html += renderTable(table, data.data[table] || []);
      }
      if (!html) {
        html = `<div class="empty-state"><h3>No tables found</h3><p>This session's database has no tables.</p></div>`;
      }
      dataViewEl.innerHTML = graphHtml + html;
    } else {
      dataViewEl.innerHTML =
        graphHtml + `<p class="placeholder">Table not found in database.</p>`;
    }
  } catch (error) {
    console.error("Failed to load session data:", error);
    dataViewEl.innerHTML = `<p class="placeholder">Error loading session data.</p>`;
  }
  attachGraphTooltips();
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  selectedTable = "";
  tableSelectEl.value = "";
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  await loadSessionData(sessionId);
}

tableSelectEl.addEventListener("change", async () => {
  selectedTable = tableSelectEl.value;
  if (selectedSessionId) {
    await loadSessionData(selectedSessionId);
  }
});

refreshTodosBtn.addEventListener("click", () => {
  void refreshSessions();
});

void refreshSessions();

connectSessionChangeEvents(refreshSessions);

initResizer();
initAppMenu();
