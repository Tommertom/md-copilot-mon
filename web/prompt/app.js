import { initResizer } from "/resizer.js";
import { renderSessionList, connectSessionChangeEvents, initAppMenu } from "/shared.js";

const sessionListEl = document.getElementById("session-list");
const currentSessionEl = document.getElementById("current-session");
const refreshSessionsBtn = document.getElementById("refresh-sessions");
const runPromptBtn = document.getElementById("run-prompt");
const promptInputEl = document.getElementById("prompt-input");
const statusTextEl = document.getElementById("status-text");
const promptOutputEl = document.getElementById("prompt-output");

let sessions = [];
let selectedSessionId = null;
let isRunning = false;

function updateRunButton() {
  const hasPrompt = promptInputEl.value.trim().length > 0;
  runPromptBtn.disabled = !selectedSessionId || !hasPrompt || isRunning;
}

async function refreshSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) {
      sessions = [];
    } else {
      const data = await res.json();
      sessions = Array.isArray(data) ? data : [];
    }
  } catch (error) {
    console.error("Failed to load sessions:", error);
    sessions = [];
  }
  if (selectedSessionId && !sessions.some((session) => session.id === selectedSessionId)) {
    selectedSessionId = null;
  }
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  if (selectedSessionId) {
    const session = sessions.find((entry) => entry.id === selectedSessionId);
    currentSessionEl.textContent = session?.title || session?.directory || "Session";
  } else {
    currentSessionEl.textContent = "Select a session to run a prompt";
  }
  updateRunButton();
}

function selectSession(sessionId) {
  selectedSessionId = sessionId;
  const session = sessions.find((entry) => entry.id === sessionId);
  currentSessionEl.textContent = session?.title || session?.directory || "Session";
  renderSessionList(sessionListEl, sessions, selectedSessionId, selectSession);
  updateRunButton();
}

async function runPrompt() {
  if (!selectedSessionId || isRunning) return;
  const prompt = promptInputEl.value.trim();
  if (!prompt) return;
  isRunning = true;
  updateRunButton();
  statusTextEl.textContent = "Running prompt...";
  promptOutputEl.textContent = "";
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      let message = "Failed to run prompt";
      try {
        const errorData = await res.json();
        if (errorData && typeof errorData.error === "string") {
          message = errorData.error;
        }
      } catch {
        try {
          const text = await res.text();
          if (text) {
            message = text;
          }
        } catch {
          // Ignore secondary body read errors
        }
      }
      throw new Error(message);
    }
    const data = await res.json();
    statusTextEl.textContent = "Prompt completed successfully.";
    promptOutputEl.textContent = typeof data.output === "string" && data.output ? data.output : "(no output)";
  } catch (error) {
    statusTextEl.textContent = `Prompt failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    isRunning = false;
    updateRunButton();
  }
}

refreshSessionsBtn.addEventListener("click", () => {
  void refreshSessions();
});

runPromptBtn.addEventListener("click", () => {
  void runPrompt();
});

promptInputEl.addEventListener("input", updateRunButton);
promptInputEl.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void runPrompt();
  }
});

void refreshSessions();
connectSessionChangeEvents(refreshSessions);
initResizer();
initAppMenu();
