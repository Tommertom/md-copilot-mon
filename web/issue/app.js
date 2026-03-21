import { initResizer } from "/resizer.js";
import { initAppMenu } from "/shared.js";

const submitIssueBtn = document.getElementById("submit-issue");
const issueTitleEl = document.getElementById("issue-title");
const issueBodyEl = document.getElementById("issue-body");
const statusTextEl = document.getElementById("status-text");
const issueOutputEl = document.getElementById("issue-output");

let isSubmitting = false;

function updateSubmitButton() {
  const hasTitle = issueTitleEl.value.trim().length > 0;
  submitIssueBtn.disabled = !hasTitle || isSubmitting;
}

async function submitIssue() {
  if (isSubmitting) return;
  const title = issueTitleEl.value.trim();
  const body = issueBodyEl.value.trim();
  if (!title) return;

  isSubmitting = true;
  updateSubmitButton();
  statusTextEl.textContent = "Submitting issue via Copilot CLI…";
  issueOutputEl.textContent = "";

  try {
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      let message = "Failed to create issue";
      try {
        const errorData = await res.json();
        if (errorData && typeof errorData.error === "string") {
          message = errorData.error;
        }
      } catch {
        // Ignore JSON parse errors; use default message
      }
      throw new Error(message);
    }
    const data = await res.json();
    statusTextEl.textContent = "Issue created successfully.";
    issueOutputEl.textContent = typeof data.output === "string" && data.output ? data.output : "(no output)";
    issueTitleEl.value = "";
    issueBodyEl.value = "";
    updateSubmitButton();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusTextEl.textContent = "Failed to create issue.";
    issueOutputEl.textContent = errorMessage;
  } finally {
    isSubmitting = false;
    updateSubmitButton();
  }
}

submitIssueBtn.addEventListener("click", () => {
  void submitIssue();
});

issueTitleEl.addEventListener("input", updateSubmitButton);

issueBodyEl.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void submitIssue();
  }
});

updateSubmitButton();
initResizer();
initAppMenu();
