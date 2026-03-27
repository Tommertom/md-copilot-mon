import { initResizer } from "/resizer.js";
import {
  escapeHtml,
  renderSessionList,
  connectSessionChangeEvents,
  initAppMenu,
} from "/shared.js";

const sessionListEl = document.getElementById("session-list");
const currentSessionEl = document.getElementById("current-session");
const refreshEventsBtn = document.getElementById("refresh-events");
const toggleSortBtn = document.getElementById("toggle-sort");
const viewTabsEl = document.getElementById("view-tabs");
const tabRenderedEl = document.getElementById("tab-rendered");
const tabRawEl = document.getElementById("tab-raw");
const statsContainerEl = document.getElementById("stats-container");
const searchBarContainerEl = document.getElementById("search-bar-container");
const eventSearchEl = document.getElementById("event-search");
const timelineContainerEl = document.getElementById("timeline-container");

let sessions = [];
let selectedSessionId = null;
let selectedView = "rendered";
let sortDirection = "desc";
let searchQuery = "";
let loadedEvents = [];
const sessionEventsCache = new Map();
let autoRefresh = false;
let autoRefreshInterval = null;

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
  const userMessages = events.filter(
    (event) => event?.type === "user.message",
  ).length;
  const assistantTurns = events.filter(
    (event) => event?.type === "assistant.turn_start",
  ).length;
  const toolStarts = events.filter(
    (event) => event?.type === "tool.execution_start",
  );
  const toolCompletions = events.filter(
    (event) => event?.type === "tool.execution_complete",
  );
  const toolFailures = toolCompletions.filter(
    (event) => event?.data?.success === false,
  ).length;

  const toolUsage = new Map();
  for (const event of toolStarts) {
    const toolName = event?.data?.toolName || "unknown";
    toolUsage.set(toolName, (toolUsage.get(toolName) || 0) + 1);
  }
  const topTools =
    [...toolUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name} (${count})`)
      .join(", ") || "None";

  const eventTimes = events
    .map((event) => new Date(event?.timestamp || "").getTime())
    .filter((time) => Number.isFinite(time));
  const firstTime = eventTimes.length > 0 ? Math.min(...eventTimes) : NaN;
  const lastTime = eventTimes.length > 0 ? Math.max(...eventTimes) : NaN;
  const durationSeconds =
    Number.isFinite(firstTime) && Number.isFinite(lastTime)
      ? Math.max(0, Math.round((lastTime - firstTime) / 1000))
      : null;

  return {
    totalEvents,
    userMessages,
    assistantTurns,
    toolCalls: toolStarts.length,
    toolFailures,
    topTools,
    durationSeconds,
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
      context.cwd ? `CWD: ${context.cwd}` : "",
    ].filter(Boolean);
    return { type, time, title: "Session started", detail: lines.join("\n") };
  }

  if (type === "user.message") {
    return {
      type,
      time,
      title: "User message",
      detail: data.content || "(no content)",
    };
  }

  if (type === "assistant.turn_start") {
    return {
      type,
      time,
      title: "Assistant turn started",
      detail: `Turn ${data.turnId || "?"}`,
    };
  }

  if (type === "assistant.turn_end") {
    return {
      type,
      time,
      title: "Assistant turn finished",
      detail: `Turn ${data.turnId || "?"}`,
    };
  }

  if (type === "assistant.message") {
    const toolRequests = Array.isArray(data.toolRequests)
      ? data.toolRequests
      : [];
    const reasoningText =
      typeof data.reasoningText === "string" && data.reasoningText.trim()
        ? data.reasoningText
        : null;
    if (toolRequests.length > 0) {
      const toolLines = toolRequests.map((tool) => {
        if (!tool) return "(unknown tool)";
        const args = tool.arguments ?? {};
        const lines = [`• ${tool.name || "unknown"}`];
        // Show the most useful argument fields: command, description, query, path, pattern, prompt, input
        const argKeys = [
          "command",
          "description",
          "query",
          "path",
          "pattern",
          "prompt",
          "input",
        ];
        for (const key of argKeys) {
          if (typeof args[key] === "string" && args[key].trim()) {
            lines.push(`  ${key}: ${args[key].trim()}`);
          }
        }
        return lines.join("\n");
      });
      const detail = [toolLines.join("\n\n"), reasoningText]
        .filter(Boolean)
        .join("\n\n---\n");
      return {
        type,
        time,
        title: "Assistant planned tool calls",
        detail,
      };
    }
    const content =
      typeof data.content === "string" && data.content.trim()
        ? data.content
        : (reasoningText ?? "(empty assistant content)");
    return {
      type,
      time,
      title: "Assistant message",
      detail: content,
      renderedContent: content,
    };
  }

  if (type === "tool.execution_start") {
    return {
      type,
      time,
      title: `Tool started: ${data.toolName || "unknown"}`,
      detail:
        data.arguments !== undefined
          ? `Arguments: ${previewJson(data.arguments, 300)}`
          : "",
    };
  }

  if (type === "tool.execution_complete") {
    const toolName =
      data.toolName || toolNamesByCallId.get(data.toolCallId) || "unknown";
    let detail = data.success === false ? "Tool failed" : "";
    if (data.error?.message) {
      detail += `\nError: ${data.error.message}`;
    }
    const truncateLines = (text, max = 15) => {
      const lines = text.split("\n");
      return lines.length > max
        ? lines.slice(0, max).join("\n") + "\n..."
        : text;
    };
    if (toolName === "report_intent") {
      if (data.result?.detailedContent) {
        detail += `\n${truncateLines(data.result.detailedContent)}`;
      }
    } else {
      if (data.result?.content) {
        detail += `\n${truncateLines(data.result.content)}`;
      }
      // if (data.result?.detailedContent) {
      //   detail += `\n${truncateLines(data.result.detailedContent)}`;
      // }
    }
    return {
      type,
      time,
      title: `Tool completed: ${toolName}`,
      detail,
    };
  }

  if (type === "session.info") {
    const infoType = data.infoType || "info";
    const message = data.message || previewJson(data, 300);
    return {
      type,
      time,
      title: `Session info: ${infoType}`,
      detail: message,
    };
  }

  if (type === "session.task_complete") {
    return {
      type,
      time,
      title: "Task complete",
      detail:
        typeof data.summary === "string" && data.summary.trim()
          ? data.summary
          : "(no summary)",
    };
  }

  if (type === "subagent.started") {
    const displayName = data.agentDisplayName || data.agentName || "unknown";
    const description = data.agentDescription || "";
    return {
      type,
      time,
      title: `Subagent started: ${displayName}`,
      detail: description,
    };
  }

  if (type === "subagent.completed") {
    const displayName = data.agentDisplayName || data.agentName || "unknown";
    const totalToolCalls = data.totalToolCalls ?? "?";
    const durationMs =
      typeof data.durationMs === "number" ? data.durationMs : null;
    let duration = "?";
    if (durationMs !== null) {
      const totalSeconds = Math.round(durationMs / 1000);
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      duration = `${mins}:${String(secs).padStart(2, "0")}`;
    }
    return {
      type,
      time,
      title: `Subagent completed: ${displayName}`,
      detail: `Tool calls: ${totalToolCalls} · Duration: ${duration}`,
    };
  }

  return {
    type,
    time,
    title: type,
    detail: previewJson(data, 300),
  };
}

function renderStats(events) {
  const stats = getSummaryStats(events);
  return `
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
}

function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<p class="placeholder">No events found for this session.</p>`;
  }
  const toolNamesByCallId = new Map();
  for (const event of events) {
    if (event?.type === "tool.execution_start" && event?.data?.toolCallId) {
      toolNamesByCallId.set(
        event.data.toolCallId,
        event.data.toolName || "unknown",
      );
    }
  }
  const timeline = events
    .map((event) => toTimelineEntry(event, toolNamesByCallId))
    .map((entry) => {
      if (
        entry.type === "assistant.turn_start" ||
        entry.type === "assistant.turn_end" ||
        entry.type === "tool.execution_start" ||
        entry.type === "session.start" ||
        entry.type === "session.mode_changed"
      ) {
        return `<div class="timeline-divider"><span>${escapeHtml(entry.time)}${entry.time ? " · " : ""}${escapeHtml(entry.type)}</span></div>`;
      }
      const detailHtml = entry.renderedContent
        ? `<div class="timeline-detail rendered-markdown">${DOMPurify.sanitize(marked.parse(entry.renderedContent))}</div>`
        : `<div class="timeline-detail">${escapeHtml(entry.detail || "")}</div>`;
      return `
      <article class="timeline-item">
        <div class="timeline-head">
          <div class="timeline-title">${escapeHtml(entry.title)}</div>
          <div class="timeline-type">${escapeHtml(entry.time)}${entry.time ? " · " : ""}${escapeHtml(entry.type)}</div>
        </div>
        ${detailHtml}
      </article>
    `;
    })
    .join("");
  return `<section class="timeline">${timeline}</section>`;
}

function getFilteredEvents(events) {
  if (!searchQuery) return events;
  const q = searchQuery.toLowerCase();
  return events.filter((event) =>
    JSON.stringify(event).toLowerCase().includes(q),
  );
}

function renderRawEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return `<p class="placeholder">No events found for this session.</p>`;
  }
  const json = JSON.stringify(events, null, 2);
  return `
    <div class="raw-toolbar">
      <button id="copy-raw-btn" type="button" class="icon-button" aria-label="Copy raw JSON to clipboard">Copy</button>
    </div>
    <pre class="json-cell" data-raw-json>${escapeHtml(json)}</pre>`;
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
  toggleSortBtn.textContent =
    sortDirection === "desc" ? "Sort: Desc" : "Sort: Asc";
}

function setActiveView(view) {
  selectedView = view;
  tabRenderedEl.classList.toggle("active", view === "rendered");
  tabRawEl.classList.toggle("active", view === "raw");
  const displayedEvents = getDisplayedEvents(loadedEvents);
  if (view === "raw") {
    statsContainerEl.innerHTML = "";
    searchBarContainerEl.hidden = true;
    timelineContainerEl.innerHTML = renderRawEvents(displayedEvents);
  } else {
    statsContainerEl.innerHTML =
      displayedEvents.length > 0 ? renderStats(displayedEvents) : "";
    searchBarContainerEl.hidden = false;
    timelineContainerEl.innerHTML = renderTimeline(
      getFilteredEvents(displayedEvents),
    );
  }
}

async function loadEvents(sessionId, { force = false } = {}) {
  if (!force && sessionEventsCache.has(sessionId)) {
    loadedEvents = sessionEventsCache.get(sessionId) || [];
    const session = sessions.find((s) => s.id === sessionId);
    currentSessionEl.textContent =
      session?.title || session?.directory || "Session";
    viewTabsEl.hidden = false;
    setActiveView(selectedView);
    return;
  }
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    if (!res.ok) {
      statsContainerEl.innerHTML = "";
      searchBarContainerEl.hidden = true;
      timelineContainerEl.innerHTML = `<p class="placeholder">Failed to load events.</p>`;
      return;
    }
    const events = await res.json();
    loadedEvents = Array.isArray(events) ? events : [];
    sessionEventsCache.set(sessionId, loadedEvents);
    const session = sessions.find((s) => s.id === sessionId);
    currentSessionEl.textContent =
      session?.title || session?.directory || "Session";
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
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  if (selectedSessionId) {
    await loadEvents(selectedSessionId, { force });
  } else {
    loadedEvents = [];
    viewTabsEl.hidden = true;
    currentSessionEl.textContent = "Select a session to view events";
    statsContainerEl.innerHTML = "";
    searchBarContainerEl.hidden = true;
    timelineContainerEl.innerHTML = `<p class="placeholder">Select a session from the sidebar to inspect events.</p>`;
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  await loadEvents(sessionId);
}

tabRenderedEl.addEventListener("click", () => {
  setActiveView("rendered");
});

tabRawEl.addEventListener("click", () => {
  setActiveView("raw");
});

timelineContainerEl.addEventListener("click", (event) => {
  if (event.target.id === "copy-raw-btn") {
    const pre = timelineContainerEl.querySelector("[data-raw-json]");
    if (!pre) return;
    void navigator.clipboard.writeText(pre.textContent).then(() => {
      const btn = event.target;
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });
  }
});

refreshEventsBtn.addEventListener("click", () => {
  autoRefresh = !autoRefresh;
  if (autoRefresh) {
    refreshEventsBtn.textContent = "Auto-Refresh: On";
    refreshEventsBtn.classList.add("active");
    void refreshSessions({ force: true });
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
      void refreshSessions({ force: true });
    }, 2000);
  } else {
    refreshEventsBtn.textContent = "Auto-Refresh: Off";
    refreshEventsBtn.classList.remove("active");
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
});

toggleSortBtn.addEventListener("click", () => {
  sortDirection = sortDirection === "desc" ? "asc" : "desc";
  updateSortToggle();
  setActiveView(selectedView);
});

eventSearchEl.addEventListener("input", () => {
  searchQuery = eventSearchEl.value;
  if (selectedView === "rendered") {
    timelineContainerEl.innerHTML = renderTimeline(
      getFilteredEvents(getDisplayedEvents(loadedEvents)),
    );
  }
});

updateSortToggle();
void refreshSessions({ force: true });

connectSessionChangeEvents(() => refreshSessions({ force: true }));
initResizer();
initAppMenu();
