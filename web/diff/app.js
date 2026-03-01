import { initResizer } from "/resizer.js";
import { renderSessionList, connectSessionChangeEvents } from "/shared.js";

const sessionListEl = document.getElementById("session-list");
const currentSessionEl = document.getElementById("current-session");
const currentSessionFolderEl = document.getElementById("current-session-folder");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("diff-output");
const refreshDiffBtn = document.getElementById("refresh-diff");
const commitMessageEl = document.getElementById("commit-message");
const commitDiffBtn = document.getElementById("commit-diff");

let sessions = [];
let selectedSessionId = null;

function showStatus(text) {
  statusEl.hidden = false;
  statusEl.textContent = text;
}

function setCommitControlsEnabled(enabled) {
  commitMessageEl.disabled = !enabled;
  commitDiffBtn.disabled = !enabled;
}

async function loadDiff(sessionId) {
  const session = sessions.find((item) => item.id === sessionId);
  currentSessionEl.textContent = session?.title || session?.directory || "Session";
  currentSessionFolderEl.textContent = "";
  showStatus("Loading git diff...");
  outputEl.innerHTML = "";
  try {
    const response = await fetch(`/api/git-diff?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload && typeof payload.error === "string"
        ? payload.error
        : `Failed to load git diff (HTTP ${response.status})`;
      throw new Error(message);
    }
    const data = await response.json();
    currentSessionFolderEl.textContent = typeof data.diffDirectory === "string" ? data.diffDirectory : "";
    if (typeof data.diff !== "string" || !data.diff.trim()) {
      showStatus("No local git diff changes found.");
      return;
    }
    statusEl.hidden = true;
    outputEl.innerHTML = window.Diff2Html.html(data.diff, {
      drawFileList: true,
      matching: "lines",
      outputFormat: "side-by-side"
    });
  } catch (error) {
    outputEl.innerHTML = "";
    showStatus(`Failed to load git diff: ${error.message}`);
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
  } else {
    setCommitControlsEnabled(false);
    currentSessionEl.textContent = "Select a session to view git diff";
    currentSessionFolderEl.textContent = "";
    outputEl.innerHTML = "";
    showStatus("Select a session from the sidebar to inspect git diff.");
  }
}

async function selectSession(sessionId) {
  const previousSession = sessions.find((item) => item.id === selectedSessionId);
  const nextSession = sessions.find((item) => item.id === sessionId);
  selectedSessionId = sessionId;
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  setCommitControlsEnabled(true);
  currentSessionEl.textContent = nextSession?.title || nextSession?.directory || "Session";
  const previousCwd = typeof previousSession?.workspace?.cwd === "string" ? previousSession.workspace.cwd.trim() : "";
  const nextCwd = typeof nextSession?.workspace?.cwd === "string" ? nextSession.workspace.cwd.trim() : "";
  if (
    previousSession &&
    previousSession.id !== sessionId &&
    previousCwd &&
    previousCwd === nextCwd
  ) {
    return;
  }
  await loadDiff(sessionId);
}

async function commitDiffChanges() {
  if (!selectedSessionId) {
    showStatus("Select a session before committing.");
    return;
  }
  const message = commitMessageEl.value.trim();
  if (!message) {
    showStatus("Enter a commit message.");
    commitMessageEl.focus();
    return;
  }
  commitDiffBtn.disabled = true;
  showStatus("Running git commit...");
  try {
    const response = await fetch("/api/git-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: selectedSessionId, message })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload && typeof payload.error === "string"
        ? payload.error
        : `Failed to commit changes (HTTP ${response.status})`;
      throw new Error(errorMessage);
    }
    commitMessageEl.value = "";
    showStatus(typeof payload.message === "string" ? payload.message : "Commit created successfully.");
    await loadDiff(selectedSessionId);
  } catch (error) {
    showStatus(`Failed to commit changes: ${error.message}`);
  } finally {
    commitDiffBtn.disabled = !selectedSessionId;
  }
}

refreshDiffBtn.addEventListener("click", () => {
  void refreshSessions();
});
commitDiffBtn.addEventListener("click", () => {
  void commitDiffChanges();
});
commitMessageEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void commitDiffChanges();
  }
});

setCommitControlsEnabled(false);

void refreshSessions();

connectSessionChangeEvents(refreshSessions);

initResizer();
