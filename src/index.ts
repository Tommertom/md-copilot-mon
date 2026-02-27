import express from "express";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToDocx, renderMarkdown } from "./markdown.js";
import { defaultRoots, MarkdownIndex } from "./watcher.js";

dotenv.config();

function parseExcludePatterns(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }
  const matches = rawValue.matchAll(/"([^"]+)"/g);
  return [...matches].map((match) => match[1]).filter((item) => item.length > 0);
}

function parseFileMaxLimit(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 200;
  }
  return Math.floor(parsed);
}

function toDisplayPath(filePath: string): string {
  const homePath = os.homedir();
  if (filePath === homePath) {
    return "~";
  }
  if (filePath.startsWith(`${homePath}/`)) {
    return `~/${filePath.slice(homePath.length + 1)}`;
  }
  return filePath;
}

const app = express();
const port = Number(process.env.PORT || 3000);
const loadExistingMd = process.env.LOAD_EXISTING_MD !== "false";
const excludePatterns = parseExcludePatterns(process.env.EXCLUDE_PATTERN);
const fileMaxLimit = parseFileMaxLimit(process.env.FILE_MAX_LIMIT);
const cwd = process.cwd();
const roots = defaultRoots(cwd);
const index = new MarkdownIndex(roots, loadExistingMd, excludePatterns);
const currentFile = fileURLToPath(import.meta.url);
const webDir = path.resolve(path.dirname(currentFile), "../web");

app.use(express.static(webDir));

app.get("/api/files", (_req, res) => {
  res.json(index.list().slice(0, fileMaxLimit).map((entry) => ({
    ...entry,
    path: toDisplayPath(entry.path)
  })));
});

app.get("/api/files/:id", async (req, res) => {
  const filePath = index.resolve(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  try {
    const markdown = await fs.readFile(filePath, "utf8");
    res.json({ path: toDisplayPath(filePath), markdown, html: renderMarkdown(markdown) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/files/:id/docx", async (req, res) => {
  const filePath = index.resolve(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  try {
    const markdown = await fs.readFile(filePath, "utf8");
    const buffer = await markdownToDocx(markdown);
    const fileName = `${path.basename(filePath, ".md")}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

async function start(): Promise<void> {
  await index.start();
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`LOAD_EXISTING_MD=${String(loadExistingMd)}`);
    console.log(`EXCLUDE_PATTERN=${excludePatterns.join(",") || "(none)"}`);
    console.log(`FILE_MAX_LIMIT=${String(fileMaxLimit)}`);
    console.log(`Watching roots:\n- ${roots.join("\n- ")}`);
  });
}

void start();
