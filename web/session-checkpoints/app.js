import { initResizer } from "/resizer.js";
import { escapeHtml, formatSize, formatMtime, renderSessionList, connectSessionChangeEvents, initAppMenu } from "/shared.js";

const sessionListEl = document.getElementById("session-list");
const dataViewEl = document.getElementById("data-view");
const currentSessionEl = document.getElementById("current-session");
const refreshSessionCheckpointsBtn = document.getElementById(
  "refresh-session-checkpoints",
);
const currentCheckpointEl = document.getElementById("current-checkpoint");
const jsonViewEl = document.getElementById("json-view");

let sessions = [];
let selectedSessionId = null;
let selectedCheckpointPath = "";
let checkpointFiles = [];

function clearJsonViewer(message) {
  currentCheckpointEl.textContent = message;
  jsonViewEl.textContent = "";
}

function tryPrettyPrintJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function renderCheckpointFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    dataViewEl.innerHTML = `<p class="placeholder">No checkpoint JSON files found for this session.</p>`;
    return;
  }
  let html = `<table class="data-table"><thead><tr><th>Path</th><th>Size</th><th>Modified</th></tr></thead><tbody>`;
  for (const file of files) {
    const rawPath = typeof file?.path === "string" ? file.path : "";
    const activeClass = selectedCheckpointPath === rawPath ? "active" : "";
    html += `<tr class="${activeClass}" data-path="${escapeHtml(rawPath)}">`;
    html += `<td>${escapeHtml(rawPath)}</td>`;
    html += `<td>${escapeHtml(formatSize(file?.size))}</td>`;
    html += `<td>${escapeHtml(formatMtime(file?.mtimeMs))}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  dataViewEl.innerHTML = html;

  const rows = dataViewEl.querySelectorAll("tbody tr[data-path]");
  for (const row of rows) {
    row.setAttribute("tabindex", "0");
    row.setAttribute("role", "button");
    const filePath = row.getAttribute("data-path") || "";
    row.addEventListener("click", () => {
      void selectCheckpointFile(filePath);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void selectCheckpointFile(filePath);
      }
    });
  }
}

async function loadSessionCheckpoints(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
    if (!res.ok) {
      dataViewEl.innerHTML = `<p class="placeholder">Failed to load session checkpoint files.</p>`;
      clearJsonViewer("Select a checkpoint JSON file to view");
      return;
    }
    const data = await res.json();
    checkpointFiles = Array.isArray(data?.files) ? data.files : [];
    const session = sessions.find((s) => s.id === sessionId);
    const title = session?.title || session?.directory || "Session";
    const directory =
      typeof data?.directory === "string" && data.directory
        ? ` — ${data.directory}`
        : "";
    currentSessionEl.textContent = `${title}${directory}`;
    if (!checkpointFiles.some((file) => file.path === selectedCheckpointPath)) {
      selectedCheckpointPath = "";
    }
    renderCheckpointFiles(checkpointFiles);
    if (selectedCheckpointPath) {
      await selectCheckpointFile(selectedCheckpointPath);
    } else {
      clearJsonViewer("Select a checkpoint JSON file to view");
    }
  } catch (error) {
    console.error("Failed to load session checkpoint files:", error);
    dataViewEl.innerHTML = `<p class="placeholder">Error loading session checkpoint files.</p>`;
    clearJsonViewer("Select a checkpoint JSON file to view");
  }
}

async function selectCheckpointFile(filePath) {
  if (!selectedSessionId || !filePath) {
    return;
  }
  selectedCheckpointPath = filePath;
  renderCheckpointFiles(checkpointFiles);
  currentCheckpointEl.textContent = `${filePath}`;
  jsonViewEl.textContent = "Loading...";
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(selectedSessionId)}/checkpoints/file?path=${encodeURIComponent(filePath)}`,
    );
    if (!res.ok) {
      jsonViewEl.textContent = "Failed to load JSON file.";
      return;
    }
    const data = await res.json();
    const content = typeof data?.content === "string" ? data.content : "";
    jsonViewEl.textContent = tryPrettyPrintJson(content);
  } catch (error) {
    console.error("Failed to load checkpoint JSON file:", error);
    jsonViewEl.textContent = "Error loading JSON file.";
  }
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
    checkpointFiles = [];
    selectedCheckpointPath = "";
  }
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  if (selectedSessionId) {
    await loadSessionCheckpoints(selectedSessionId);
  } else {
    currentSessionEl.textContent = "Select a session to view checkpoints";
    dataViewEl.innerHTML = `<p class="placeholder">Select a session from the sidebar to inspect checkpoint files.</p>`;
    clearJsonViewer("Select a checkpoint JSON file to view");
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  selectedCheckpointPath = "";
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  await loadSessionCheckpoints(sessionId);
}

refreshSessionCheckpointsBtn.addEventListener("click", () => {
  void refreshSessions();
});

void refreshSessions();

connectSessionChangeEvents(refreshSessions);

initResizer();
initAppMenu();
