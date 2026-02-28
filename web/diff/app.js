const statusEl = document.getElementById("status");
const outputEl = document.getElementById("diff-output");

async function loadDiff() {
  try {
    const response = await fetch("/api/git-diff");
    if (!response.ok) {
      throw new Error(`Failed to load git diff (HTTP ${response.status})`);
    }
    const data = await response.json();
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
