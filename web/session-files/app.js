import { initResizer } from "/resizer.js";
import { escapeHtml, formatSize, formatMtime, renderSessionList, connectSessionChangeEvents, initAppMenu } from "/shared.js";

const sessionListEl = document.getElementById("session-list");
const dataViewEl = document.getElementById("data-view");
const currentSessionEl = document.getElementById("current-session");
const refreshSessionFilesBtn = document.getElementById("refresh-session-files");

let sessions = [];
let selectedSessionId = null;

function renderFiles(files, sessionId) {
  if (!Array.isArray(files) || files.length === 0) {
    return `<p class="placeholder">No files found for this session.</p>`;
  }
  let html = `<table class="data-table"><thead><tr><th>Path</th><th>Size</th><th>Modified</th><th>Download</th></tr></thead><tbody>`;
  for (const file of files) {
    const rawPath = typeof file?.path === "string" ? file.path : "";
    const downloadUrl = `/api/sessions/${encodeURIComponent(sessionId)}/files/download?path=${encodeURIComponent(rawPath)}`;
    html += "<tr>";
    html += `<td>${escapeHtml(rawPath)}</td>`;
    html += `<td>${escapeHtml(formatSize(file?.size))}</td>`;
    html += `<td>${escapeHtml(formatMtime(file?.mtimeMs))}</td>`;
    html += `<td><a class="download-link" href="${downloadUrl}">Download</a></td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

async function loadSessionFiles(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
    if (!res.ok) {
      dataViewEl.innerHTML = `<p class="placeholder">Failed to load session files.</p>`;
      return;
    }
    const data = await res.json();
    const session = sessions.find((s) => s.id === sessionId);
    const title = session?.title || session?.directory || "Session";
    const directory = typeof data?.directory === "string" && data.directory ? ` — ${data.directory}` : "";
    currentSessionEl.textContent = `${title}${directory}`;
    dataViewEl.innerHTML = renderFiles(data?.files, sessionId);
  } catch (error) {
    console.error("Failed to load session files:", error);
    dataViewEl.innerHTML = `<p class="placeholder">Error loading session files.</p>`;
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
  }
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  if (selectedSessionId) {
    await loadSessionFiles(selectedSessionId);
  } else {
    currentSessionEl.textContent = "Select a session to view files";
    dataViewEl.innerHTML = `<p class="placeholder">Select a session from the sidebar to inspect files.</p>`;
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  await loadSessionFiles(sessionId);
}

refreshSessionFilesBtn.addEventListener("click", () => {
  void refreshSessions();
});

void refreshSessions();

connectSessionChangeEvents(refreshSessions);

initResizer();
initAppMenu();
