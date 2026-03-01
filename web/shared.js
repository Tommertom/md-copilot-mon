/**
 * Escapes a string for safe insertion into HTML.
 */
export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Formats a byte count as a human-readable string (B, KB, MB, GB).
 */
export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Formats a millisecond timestamp as a locale date-time string.
 */
export function formatMtime(mtimeMs) {
  const value = Number(mtimeMs);
  if (!Number.isFinite(value)) return "";
  return new Date(value).toLocaleString();
}

/**
 * Renders the session sidebar list.
 * @param {HTMLElement} sessionListEl - The <ul> element to render into.
 * @param {Array} sessions - Array of session objects.
 * @param {string|null} selectedSessionId - The currently selected session ID.
 * @param {function} onSelect - Called with session.id when a session is clicked.
 */
export function renderSessionList(sessionListEl, sessions, selectedSessionId, onSelect) {
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
    li.addEventListener("click", () => onSelect(session.id));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(session.id);
      }
    });
    sessionListEl.appendChild(li);
  }
}

/**
 * Connects to the /api/session-changes SSE endpoint and calls onRefresh
 * (debounced 200ms) whenever a change event arrives. Reconnects after 1s on error.
 * @param {function} onRefresh - Async function to call on session changes.
 */
export function connectSessionChangeEvents(onRefresh) {
  let reconnectTimer = null;
  let refreshDebounceTimer = null;

  function connect() {
    const events = new EventSource("/api/session-changes");
    events.onmessage = () => {
      if (refreshDebounceTimer !== null) {
        clearTimeout(refreshDebounceTimer);
      }
      refreshDebounceTimer = setTimeout(() => {
        refreshDebounceTimer = null;
        void onRefresh();
      }, 200);
    };
    events.onerror = () => {
      events.close();
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1000);
    };
  }

  connect();
}
