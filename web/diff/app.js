const statusEl = document.getElementById("status");
const outputEl = document.getElementById("diff-output");

async function loadDiff() {
  try {
    const response = await fetch("/api/git-diff");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to load git diff");
    }
    if (!data.diff.trim()) {
      statusEl.textContent = "No local git diff changes found.";
      return;
    }
    statusEl.remove();
    outputEl.innerHTML = window.Diff2Html.html(data.diff, {
      drawFileList: true,
      matching: "lines",
      outputFormat: "side-by-side"
    });
  } catch (error) {
    statusEl.textContent = `Failed to load git diff: ${error.message}`;
  }
}

void loadDiff();
