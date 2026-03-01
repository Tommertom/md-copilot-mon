import { initResizer } from "/resizer.js";

const sessionListEl = document.getElementById("session-list");
const dataViewEl = document.getElementById("data-view");
const currentSessionEl = document.getElementById("current-session");
const tableSelectEl = document.getElementById("table-select");
const refreshTodosBtn = document.getElementById("refresh-todos");

let sessions = [];
let selectedSessionId = null;
let selectedTable = "";

function renderSessionList() {
  sessionListEl.innerHTML = "";
  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = selectedSessionId === session.id ? "active" : "";
    const label = document.createElement("div");
    label.className = "session-item-label";
    const title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = session.title || session.directory;
    const dirPath = document.createElement("span");
    dirPath.className = "session-item-path";
    dirPath.textContent = session.directory;
    label.append(title, dirPath);
    li.appendChild(label);
    li.setAttribute("tabindex", "0");
    li.setAttribute("role", "button");
    li.addEventListener("click", () => selectSession(session.id));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSession(session.id);
      }
    });
    sessionListEl.appendChild(li);
  }
}

function statusClass(value) {
  if (typeof value !== "string") return "";
  const normalized = value.toLowerCase().replace(/\s+/g, "_");
  const knownStatuses = [
    "done", "completed", "in_progress", "in-progress", "active",
    "pending", "todo", "open", "failed", "error", "blocked"
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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
  renderSessionList();
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
    updateTableSelect(data.tables || []);

    if (selectedTable && data.data[selectedTable]) {
      dataViewEl.innerHTML = renderTable(selectedTable, data.data[selectedTable]);
    } else if (!selectedTable) {
      let html = "";
      for (const table of data.tables || []) {
        html += renderTable(table, data.data[table] || []);
      }
      if (!html) {
        html = `<div class="empty-state"><h3>No tables found</h3><p>This session's database has no tables.</p></div>`;
      }
      dataViewEl.innerHTML = html;
    } else {
      dataViewEl.innerHTML = `<p class="placeholder">Table not found in database.</p>`;
    }
  } catch (error) {
    console.error("Failed to load session data:", error);
    dataViewEl.innerHTML = `<p class="placeholder">Error loading session data.</p>`;
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  selectedTable = "";
  tableSelectEl.value = "";
  renderSessionList();
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

let reconnectTimer = null;
let refreshDebounceTimer = null;

function connectSessionChangeEvents() {
  const events = new EventSource("/api/session-changes");
  events.onmessage = () => {
    if (refreshDebounceTimer !== null) {
      clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      void refreshSessions();
    }, 200);
  };
  events.onerror = () => {
    events.close();
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSessionChangeEvents();
    }, 1000);
  };
}

connectSessionChangeEvents();

initResizer();
