const fileListEl = document.getElementById("file-list");
const previewEl = document.getElementById("preview");
const currentFileEl = document.getElementById("current-file");
const downloadBtn = document.getElementById("download-docx");

let files = [];
let selectedId = null;

function renderList() {
  fileListEl.innerHTML = "";
  for (const file of files) {
    const li = document.createElement("li");
    li.textContent = `${file.path} (${new Date(file.mtimeMs).toLocaleString()})`;
    li.className = selectedId === file.id ? "active" : "";
    li.addEventListener("click", () => selectFile(file.id));
    fileListEl.appendChild(li);
  }
}

async function refreshFiles() {
  const res = await fetch("/api/files");
  files = await res.json();
  if (!selectedId && files.length > 0) {
    selectedId = files[0].id;
  }
  if (selectedId && !files.some((f) => f.id === selectedId)) {
    selectedId = files[0]?.id ?? null;
  }
  renderList();
  if (selectedId) {
    await loadPreview(selectedId);
  } else {
    previewEl.innerHTML = "<p>No markdown files found yet.</p>";
    currentFileEl.textContent = "";
    downloadBtn.disabled = true;
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
  renderList();
  previewEl.innerHTML = data.html;
  currentFileEl.textContent = data.path;
  downloadBtn.disabled = false;
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

refreshFiles();
setInterval(refreshFiles, 2000);
