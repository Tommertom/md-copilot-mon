const fileListEl = document.getElementById("file-list");
const searchInputEl = document.getElementById("file-search");
const editorEl = document.getElementById("editor");
const currentFileEl = document.getElementById("current-file");
const downloadMdBtn = document.getElementById("download-md");
const downloadDocxBtn = document.getElementById("download-docx");
const saveBtn = document.getElementById("save-file");

const turndownService = new window.TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

turndownService.addRule("mermaid", {
  filter(node) {
    return node.classList && node.classList.contains("mermaid-wrapper");
  },
  replacement(_content, node) {
    const sourceElement = node.querySelector(".mermaid-source");
    if (!sourceElement) {
      return "";
    }
    const source = sourceElement.textContent.trim();
    return `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n`;
  }
});

let files = [];
let selectedId = null;
let loadedId = null;
let searchQuery = "";
let initialized = false;
let loadedMarkdown = "";
let isSaving = false;
let mermaidCounter = 0;
const knownIds = new Set();
const unreadIds = new Set();

function normalizeMarkdown(markdown) {
  return markdown.replace(/\r\n/g, "\n").trimEnd();
}

function getEditorMarkdown() {
  return turndownService.turndown(editorEl.innerHTML);
}

function setEditorEnabled(enabled) {
  editorEl.contentEditable = enabled ? "true" : "false";
}

function setEditorHtml(html) {
  editorEl.innerHTML = html;
}

function updateSaveButtonState() {
  const hasChanges = normalizeMarkdown(getEditorMarkdown()) !== normalizeMarkdown(loadedMarkdown);
  saveBtn.disabled = isSaving || !selectedId || !hasChanges;
}

function renderList() {
  fileListEl.innerHTML = "";
  const query = searchQuery.toLowerCase();
  const visibleFiles = query
    ? files.filter((file) =>
      file.path.toLowerCase().includes(query) || (file.title || "").toLowerCase().includes(query))
    : files;
  for (const file of visibleFiles) {
    const li = document.createElement("li");
    li.className = selectedId === file.id ? "active" : "";
    const label = document.createElement("div");
    label.className = "file-item-label";
    const title = document.createElement("span");
    title.className = "file-item-title";
    title.textContent = file.title || file.path;
    const filePath = document.createElement("span");
    filePath.className = "file-item-path";
    filePath.textContent = file.path;
    label.append(title, filePath);
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

async function renderMermaidInEditor() {
  const mermaid = window.__mermaid;
  if (!mermaid) {
    return;
  }

  const sourceBlocks = editorEl.querySelectorAll("pre.mermaid");
  for (const block of sourceBlocks) {
    const source = block.textContent || "";
    const wrapper = document.createElement("div");
    wrapper.className = "mermaid-wrapper";
    wrapper.setAttribute("contenteditable", "false");

    const sourceElement = document.createElement("pre");
    sourceElement.className = "mermaid-source";
    sourceElement.textContent = source;

    const diagramElement = document.createElement("div");
    diagramElement.className = "mermaid-diagram";

    wrapper.append(sourceElement, diagramElement);
    block.replaceWith(wrapper);
  }

  mermaid.initialize({ startOnLoad: false });

  const wrappers = editorEl.querySelectorAll(".mermaid-wrapper");
  for (const wrapper of wrappers) {
    const sourceElement = wrapper.querySelector(".mermaid-source");
    const diagramElement = wrapper.querySelector(".mermaid-diagram");
    if (!sourceElement || !diagramElement) {
      continue;
    }

    const source = sourceElement.textContent.trim();
    if (!source) {
      continue;
    }

    try {
      const id = `mermaid-${Date.now()}-${mermaidCounter++}`;
      const { svg } = await mermaid.render(id, source);
      diagramElement.innerHTML = svg;
    } catch (error) {
      console.error("Failed to render mermaid diagram", error);
      diagramElement.textContent = "Failed to render mermaid diagram.";
    }
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
    const hasUnsavedChanges = normalizeMarkdown(getEditorMarkdown()) !== normalizeMarkdown(loadedMarkdown);
    const shouldReloadFromServer = !hasUnsavedChanges || loadedId !== selectedId;
    if (shouldReloadFromServer) {
      await loadPreview(selectedId);
    }
  } else {
    loadedId = null;
    loadedMarkdown = "";
    setEditorHtml("<p>No markdown files found yet.</p>");
    setEditorEnabled(false);
    currentFileEl.textContent = "";
    downloadMdBtn.disabled = true;
    downloadDocxBtn.disabled = true;
    saveBtn.disabled = true;
  }
}

async function loadPreview(id) {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`);
  if (!res.ok) {
    setEditorHtml("<p>Failed to load file.</p>");
    setEditorEnabled(false);
    return;
  }
  const data = await res.json();
  selectedId = id;
  loadedId = id;
  unreadIds.delete(id);
  loadedMarkdown = data.markdown;
  renderList();
  setEditorHtml(data.html);
  setEditorEnabled(true);
  await renderMermaidInEditor();
  currentFileEl.textContent = data.path;
  downloadMdBtn.disabled = false;
  downloadDocxBtn.disabled = false;
  updateSaveButtonState();
}

async function selectFile(id) {
  await loadPreview(id);
}

downloadMdBtn.addEventListener("click", () => {
  if (!selectedId) return;
  const displayedPath = currentFileEl.textContent.trim();
  const baseName = displayedPath ? (displayedPath.split("/").pop() || "markdown.md") : "markdown.md";
  const fileName = baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;
  const blob = new Blob([getEditorMarkdown()], { type: "text/markdown;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  link.click();
  queueMicrotask(() => URL.revokeObjectURL(downloadUrl));
});

downloadDocxBtn.addEventListener("click", () => {
  if (!selectedId) return;
  window.location.href = `/api/files/${encodeURIComponent(selectedId)}/docx`;
});

saveBtn.addEventListener("click", async () => {
  if (!selectedId || isSaving) return;
  const savingId = selectedId;
  const markdown = getEditorMarkdown();
  const baseMarkdown = loadedMarkdown;
  isSaving = true;
  updateSaveButtonState();
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(savingId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, baseMarkdown })
    });
    if (res.status === 409) {
      let errorData;
      try {
        errorData = await res.json();
      } catch (error) {
        console.error("Failed to parse conflict response JSON", error);
        alert("Conflict detected, but failed to load latest file content from server.");
        return;
      }
      const reloadTheirs = window.confirm("This file was modified on disk. Click OK to load the server version (your edits will be lost), or Cancel to keep editing your current version.");
      if (reloadTheirs) {
        if (typeof errorData.markdown !== "string" || typeof errorData.html !== "string") {
          alert("Failed to reload latest file content.");
          return;
        }
        loadedMarkdown = errorData.markdown;
        setEditorHtml(errorData.html);
        await renderMermaidInEditor();
        await refreshFiles();
      }
      return;
    }
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const details = errorData.error ? `: ${errorData.error}` : ` (HTTP ${res.status})`;
      alert(`Failed to save file${details}`);
      return;
    }
    const data = await res.json();
    loadedMarkdown = data.markdown;
    if (selectedId === savingId && normalizeMarkdown(getEditorMarkdown()) === normalizeMarkdown(markdown)) {
      setEditorHtml(data.html);
      await renderMermaidInEditor();
    }
    await refreshFiles();
  } finally {
    isSaving = false;
    updateSaveButtonState();
  }
});

editorEl.addEventListener("input", () => {
  updateSaveButtonState();
});

searchInputEl.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  renderList();
});

refreshFiles();

let reconnectTimer = null;
let refreshDebounceTimer = null;

function connectChangeEvents() {
  const changeEvents = new EventSource("/api/changes");
  changeEvents.onmessage = () => {
    if (refreshDebounceTimer !== null) {
      clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = setTimeout(() => {
      refreshDebounceTimer = null;
      void refreshFiles();
    }, 200);
  };
  changeEvents.onerror = () => {
    changeEvents.close();
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectChangeEvents();
    }, 1000);
  };
}

connectChangeEvents();
