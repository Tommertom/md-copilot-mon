import { initResizer } from "/resizer.js";

const sessionListEl = document.getElementById("session-list");
const dataViewEl = document.getElementById("data-view");
const currentSessionEl = document.getElementById("current-session");
const refreshEventsBtn = document.getElementById("refresh-events");
const toggleSortBtn = document.getElementById("toggle-sort");
const viewTabsEl = document.getElementById("view-tabs");
const tabRenderedEl = document.getElementById("tab-rendered");
const tabRawEl = document.getElementById("tab-raw");

let sessions = [];
let selectedSessionId = null;
let selectedView = "rendered";
let sortDirection = "desc";
let loadedEvents = [];
const sessionEventsCache = new Map();

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
        void selectSession(session.id);
      }
    });
    sessionListEl.appendChild(li);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function previewJson(value, max = 240) {
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return String(value ?? "");
  }
}

function formatTimestamp(value) {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getSummaryStats(events) {
  const totalEvents = events.length;
  const userMessages = events.filter((event) => event?.type === "user.message").length;
  const assistantTurns = events.filter((event) => event?.type === "assistant.turn_start").length;
  const toolStarts = events.filter((event) => event?.type === "tool.execution_start");
  const toolCompletions = events.filter((event) => event?.type === "tool.execution_complete");
  const toolFailures = toolCompletions.filter((event) => event?.data?.success === false).length;

  const toolUsage = new Map();
  for (const event of toolStarts) {
    const toolName = event?.data?.toolName || "unknown";
    toolUsage.set(toolName, (toolUsage.get(toolName) || 0) + 1);
  }
  const topTools = [...toolUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ") || "None";

  const eventTimes = events
    .map((event) => new Date(event?.timestamp || "").getTime())
    .filter((time) => Number.isFinite(time));
  const firstTime = eventTimes.length > 0 ? Math.min(...eventTimes) : NaN;
  const lastTime = eventTimes.length > 0 ? Math.max(...eventTimes) : NaN;
  const durationSeconds = Number.isFinite(firstTime) && Number.isFinite(lastTime)
    ? Math.max(0, Math.round((lastTime - firstTime) / 1000))
    : null;

  return {
    totalEvents,
    userMessages,
    assistantTurns,
    toolCalls: toolStarts.length,
    toolFailures,
    topTools,
    durationSeconds
  };
}

function toTimelineEntry(event, toolNamesByCallId) {
  const type = event?.type || "unknown";
  const data = event?.data || {};
  const time = formatTimestamp(event?.timestamp);

  if (type === "session.start") {
    const context = data.context || {};
    const lines = [
      data.copilotVersion ? `Copilot: ${data.copilotVersion}` : "",
      context.repository ? `Repository: ${context.repository}` : "",
      context.branch ? `Branch: ${context.branch}` : "",
      context.cwd ? `CWD: ${context.cwd}` : ""
    ].filter(Boolean);
    return { type, time, title: "Session started", detail: lines.join("\n") };
  }

  if (type === "user.message") {
    return {
      type,
      time,
      title: "User message",
      detail: data.content || "(no content)"
    };
  }

  if (type === "assistant.turn_start") {
    return { type, time, title: "Assistant turn started", detail: `Turn ${data.turnId || "?"}` };
  }

  if (type === "assistant.turn_end") {
    return { type, time, title: "Assistant turn finished", detail: `Turn ${data.turnId || "?"}` };
  }

  if (type === "assistant.message") {
    const requestedTools = Array.isArray(data.toolRequests)
      ? data.toolRequests.map((tool) => tool?.name).filter(Boolean)
      : [];
    if (requestedTools.length > 0) {
      return {
        type,
        time,
        title: "Assistant planned tool calls",
        detail: requestedTools.join(", ")
      };
    }
    const content = typeof data.content === "string" && data.content.trim()
      ? data.content
      : "(empty assistant content)";
    return {
      type,
      time,
      title: "Assistant message",
      detail: content
    };
  }

  if (type === "tool.execution_start") {
    if (data.toolCallId) {
      toolNamesByCallId.set(data.toolCallId, data.toolName || "unknown");
    }
    return {
      type,
      time,
      title: `Tool started: ${data.toolName || "unknown"}`,
      detail: data.arguments !== undefined
        ? `Arguments: ${previewJson(data.arguments, 300)}`
        : ""
    };
  }

  if (type === "tool.execution_complete") {
    const toolName = data.toolName || toolNamesByCallId.get(data.toolCallId) || "unknown";
    const status = data.success === false ? "failed" : "succeeded";
    let detail = `Result: ${status}`;
    if (data.error?.message) {
      detail += `\nError: ${data.error.message}`;
    } else if (data.result?.content) {
      detail += `\nOutput: ${data.result.content}`;
    } else if (data.result?.detailedContent) {
      detail += `\nOutput: ${data.result.detailedContent}`;
    }
    return {
      type,
      time,
      title: `Tool completed: ${toolName}`,
      detail
    };
  }

  return {
    type,
    time,
    title: type,
    detail: previewJson(data, 300)
  };
}

function renderRenderedEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<p class="placeholder">No events found for this session.</p>`;
  }

  const stats = getSummaryStats(events);
  const summaryHtml = `
    <div class="summary-grid">
      <div class="summary-card"><div class="summary-label">Total events</div><div class="summary-value">${stats.totalEvents}</div></div>
      <div class="summary-card"><div class="summary-label">User messages</div><div class="summary-value">${stats.userMessages}</div></div>
      <div class="summary-card"><div class="summary-label">Assistant turns</div><div class="summary-value">${stats.assistantTurns}</div></div>
      <div class="summary-card"><div class="summary-label">Tool calls</div><div class="summary-value">${stats.toolCalls}</div></div>
      <div class="summary-card"><div class="summary-label">Tool failures</div><div class="summary-value">${stats.toolFailures}</div></div>
      <div class="summary-card"><div class="summary-label">Session duration (sec)</div><div class="summary-value">${stats.durationSeconds ?? "-"}</div></div>
      <div class="summary-card"><div class="summary-label">Top tools</div><div class="summary-value">${escapeHtml(stats.topTools)}</div></div>
    </div>
  `;

  const toolNamesByCallId = new Map();
  const timeline = events
    .map((event) => toTimelineEntry(event, toolNamesByCallId))
    .map((entry) => `
      <article class="timeline-item">
        <div class="timeline-head">
          <div class="timeline-title">${escapeHtml(entry.title)}</div>
          <div class="timeline-type">${escapeHtml(entry.time)}${entry.time ? " · " : ""}${escapeHtml(entry.type)}</div>
        </div>
        <div class="timeline-detail">${escapeHtml(entry.detail || "")}</div>
      </article>
    `)
    .join("");

  return `${summaryHtml}<section class="timeline">${timeline}</section>`;
}

function renderRawEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<p class="placeholder">No events found for this session.</p>`;
  }
  return `<pre class="json-cell">${escapeHtml(JSON.stringify(events, null, 2))}</pre>`;
}

function getDisplayedEvents(events) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const aTime = new Date(a.event?.timestamp || "").getTime();
      const bTime = new Date(b.event?.timestamp || "").getTime();
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return (aTime - bTime) * direction;
      }
      return (a.index - b.index) * direction;
    })
    .map((entry) => entry.event);
}

function updateSortToggle() {
  toggleSortBtn.textContent = sortDirection === "desc" ? "Sort: Desc" : "Sort: Asc";
}

function setActiveView(view) {
  selectedView = view;
  tabRenderedEl.classList.toggle("active", view === "rendered");
  tabRawEl.classList.toggle("active", view === "raw");
  const displayedEvents = getDisplayedEvents(loadedEvents);
  dataViewEl.innerHTML = view === "raw"
    ? renderRawEvents(displayedEvents)
    : renderRenderedEvents(displayedEvents);
}

async function loadEvents(sessionId, { force = false } = {}) {
  if (!force && sessionEventsCache.has(sessionId)) {
    loadedEvents = sessionEventsCache.get(sessionId) || [];
    const session = sessions.find((s) => s.id === sessionId);
    currentSessionEl.textContent = session?.title || session?.directory || "Session";
    viewTabsEl.hidden = false;
    setActiveView(selectedView);
    return;
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    if (!res.ok) {
      dataViewEl.innerHTML = `<p class="placeholder">Failed to load events.</p>`;
      return;
    }
    const events = await res.json();
    loadedEvents = Array.isArray(events) ? events : [];
    sessionEventsCache.set(sessionId, loadedEvents);
    const session = sessions.find((s) => s.id === sessionId);
    currentSessionEl.textContent = session?.title || session?.directory || "Session";
    viewTabsEl.hidden = false;
    setActiveView(selectedView);
  } catch (error) {
    console.error("Failed to load events:", error);
    dataViewEl.innerHTML = `<p class="placeholder">Error loading events.</p>`;
  }
}

async function refreshSessions({ force = false } = {}) {
  if (force) {
    sessionEventsCache.clear();
  }
  if (force || sessions.length === 0) {
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
  }

  if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = null;
  }
  renderSessionList();
  if (selectedSessionId) {
    await loadEvents(selectedSessionId, { force });
  } else {
    loadedEvents = [];
    viewTabsEl.hidden = true;
    currentSessionEl.textContent = "Select a session to view events";
    dataViewEl.innerHTML = `<p class="placeholder">Select a session from the sidebar to inspect events.</p>`;
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderSessionList();
  await loadEvents(sessionId);
}

tabRenderedEl.addEventListener("click", () => {
  setActiveView("rendered");
});

tabRawEl.addEventListener("click", () => {
  setActiveView("raw");
});

refreshEventsBtn.addEventListener("click", () => {
  void refreshSessions({ force: true });
});

toggleSortBtn.addEventListener("click", () => {
  sortDirection = sortDirection === "desc" ? "asc" : "desc";
  updateSortToggle();
  setActiveView(selectedView);
});

updateSortToggle();
void refreshSessions({ force: true });

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
      void refreshSessions({ force: true });
    }, 200);
  };
  events.onerror = () => {
    events.close();
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSessionChangeEvents();
    }, 1000);
  };
}

connectSessionChangeEvents();
initResizer();
