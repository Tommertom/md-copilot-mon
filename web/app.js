const fileListEl = document.getElementById("file-list");
const searchInputEl = document.getElementById("file-search");
const previewEl = document.getElementById("preview");
const editorEl = document.getElementById("editor");
const currentFileEl = document.getElementById("current-file");
const downloadBtn = document.getElementById("download-docx");
const saveBtn = document.getElementById("save-file");

let files = [];
let selectedId = null;
let loadedId = null;
let searchQuery = "";
let initialized = false;
let loadedMarkdown = "";
const knownIds = new Set();
const unreadIds = new Set();

function renderList() {
  fileListEl.innerHTML = "";
  const query = searchQuery.toLowerCase();
  const visibleFiles = query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files;
  for (const file of visibleFiles) {
    const li = document.createElement("li");
    li.className = selectedId === file.id ? "active" : "";
    const label = document.createElement("span");
    label.className = "file-item-label";
    label.textContent = `${file.path} (${new Date(file.mtimeMs).toLocaleString()})`;
    li.appendChild(label);
    if (unreadIds.has(file.id)) {
      const dot = document.createElement("span");
      dot.className = "unread-dot";
      dot.setAttribute("aria-label", "New file");
      li.appendChild(dot);
    }
    li.addEventListener("click", () => selectFile(file.id));
    fileListEl.appendChild(li);
  }
}

async function refreshFiles() {
  const res = await fetch("/api/files");
  files = await res.json();
  const currentIds = new Set(files.map((f) => f.id));
  if (!initialized) {
    for (const file of files) {
      knownIds.add(file.id);
    }
    initialized = true;
  } else {
    for (const file of files) {
      if (!knownIds.has(file.id)) {
        unreadIds.add(file.id);
        knownIds.add(file.id);
      }
    }
  }
  for (const id of [...unreadIds]) {
    if (!currentIds.has(id)) {
      unreadIds.delete(id);
    }
  }
  if (!selectedId && files.length > 0) {
    selectedId = files[0].id;
  }
  if (selectedId && !files.some((f) => f.id === selectedId)) {
    selectedId = files[0]?.id ?? null;
  }
  renderList();
  if (selectedId) {
    const hasUnsavedChanges = editorEl.value !== loadedMarkdown;
    const shouldReloadFromServer = !hasUnsavedChanges || loadedId !== selectedId;
    if (shouldReloadFromServer) {
      await loadPreview(selectedId);
    }
  } else {
    loadedId = null;
    previewEl.innerHTML = "<p>No markdown files found yet.</p>";
    editorEl.value = "";
    editorEl.disabled = true;
    currentFileEl.textContent = "";
    downloadBtn.disabled = true;
    saveBtn.disabled = true;
  }
}

async function loadPreview(id) {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`);
  if (!res.ok) {
    previewEl.textContent = "Failed to load file.";
    return;
  }
  const data = await res.json();
  selectedId = id;
  loadedId = id;
  unreadIds.delete(id);
  loadedMarkdown = data.markdown;
  renderList();
  editorEl.value = data.markdown;
  editorEl.disabled = false;
  previewEl.innerHTML = data.html;
  currentFileEl.textContent = data.path;
  downloadBtn.disabled = false;
  saveBtn.disabled = true;
  const mermaid = window.__mermaid;
  if (mermaid) {
    mermaid.initialize({ startOnLoad: false });
    await mermaid.run({ nodes: previewEl.querySelectorAll(".mermaid") });
  }
}

async function selectFile(id) {
  await loadPreview(id);
}

downloadBtn.addEventListener("click", () => {
  if (!selectedId) return;
  window.location.href = `/api/files/${encodeURIComponent(selectedId)}/docx`;
});

saveBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  const markdown = editorEl.value;
  const res = await fetch(`/api/files/${encodeURIComponent(selectedId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown })
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const details = errorData.error ? `: ${errorData.error}` : ` (HTTP ${res.status})`;
    alert(`Failed to save file${details}`);
    return;
  }
  const data = await res.json();
  loadedMarkdown = data.markdown;
  previewEl.innerHTML = data.html;
  saveBtn.disabled = true;
  await refreshFiles();
});

editorEl.addEventListener("input", () => {
  saveBtn.disabled = !selectedId || editorEl.value === loadedMarkdown;
});

searchInputEl.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  renderList();
});

refreshFiles();
setInterval(refreshFiles, 2000);
