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
 * Initialises the 6-dot app navigation menu for sub-apps.
 * Builds menu items for all apps; also adds a dedicated "md mon" entry that
 * navigates back to the main app ("/"), and disables the item matching the
 * current page.
 * Safe to call multiple times; re-entrant calls are ignored.
 */
let appMenuInitialized = false;
let frontendConfigPromise = null;

export async function getFrontendConfig() {
  if (!frontendConfigPromise) {
    frontendConfigPromise = fetch("/api/frontend-config")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .catch((error) => {
        console.error("Failed to load frontend config", error);
        return { experimental: false };
      });
  }
  return frontendConfigPromise;
}

export async function initAppMenu() {
  if (appMenuInitialized) return;
  const appMenuButton = document.getElementById("app-menu-button");
  const appMenuEl = document.getElementById("app-menu");
  const appMenuContainer = appMenuButton?.closest(".app-menu");
  if (!appMenuButton || !appMenuEl) return;
  appMenuInitialized = true;
  const { experimental = false } = await getFrontendConfig();

  function setAppMenuOpen(isOpen) {
    appMenuEl.hidden = !isOpen;
    appMenuButton.setAttribute("aria-expanded", String(isOpen));
  }

  const allApps = [
    { label: "Git Diff", path: "/diff/" },
    { label: "Todos", path: "/todos/" },
    { label: "Events", path: "/events/" },
    { label: "Prompt", path: "/prompt/" },
    { label: "Files", path: "/session-files/" },
    { label: "Checkpoints", path: "/session-checkpoints/" },
    { label: "Research", path: "/session-research/" },
    { label: "Issue", path: "/issue/" },
  ];

  // Normalise current path to always have a trailing slash.
  const currentPath = window.location.pathname.replace(/\/$/, "") + "/";

  const popupFeatures =
    "popup=yes,menubar=no,toolbar=no,location=no,locationbar=no,status=no,scrollbars=yes,resizable=yes,width=1200,height=800,noopener,noreferrer";

  function openInNewWindow(path) {
    const win = window.open(path, "_blank", popupFeatures);
    win?.focus();
  }

  // Always show a dedicated "md mon" entry that opens the main app in a new window.
  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.className = "menu-item";
  homeBtn.textContent = "md mon";
  homeBtn.addEventListener("click", () => {
    setAppMenuOpen(false);
    openInNewWindow("/");
  });
  appMenuEl.appendChild(homeBtn);

  for (const app of allApps) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.textContent = app.label;
    const isCurrent = currentPath === app.path;
    if (isCurrent) {
      btn.disabled = true;
      btn.setAttribute("aria-current", "page");
    } else {
      btn.addEventListener("click", () => {
        setAppMenuOpen(false);
        openInNewWindow(app.path);
      });
    }
    appMenuEl.appendChild(btn);
  }

  appMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setAppMenuOpen(appMenuEl.hidden);
  });

  document.addEventListener("click", (event) => {
    if (!appMenuContainer?.contains(event.target)) {
      setAppMenuOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !appMenuEl.hidden) {
      setAppMenuOpen(false);
    }
  });
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
