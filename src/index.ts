import rateLimit from "express-rate-limit";
import express, { type Request, type Response } from "express";
import dotenv from "dotenv";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { markdownToDocx, renderMarkdown } from "./markdown.js";
import { discoverSessions, getAllSessionData, getSessionTableData, type SessionInfo } from "./session-store.js";
import { defaultRoots, MarkdownIndex } from "./watcher.js";

const ENV_FILE_NAME = ".env-md-copilot-viewer";
const ENV_TEMPLATE_NAME = ".env.template";
const DEFAULT_ENV_TEMPLATE = `# Server port used by \`npm run dev\` / \`npm start\` (defaults to 3011)
PORT=3011
# true: if PORT is in use, keep incrementing until a free port is found
AUTO_INCREMENT_PORT=true

# true: include existing .md files at startup, false: only track newly created files after startup
LOAD_EXISTING_MD=true

# Comma-separated quoted path substrings to exclude from results
# Example: "checkpoints/index.md","tmp/","node_modules/"
EXCLUDE_PATTERN='"checkpoints/index.md"'

# Maximum number of most recently updated files sent to the frontend
FILE_MAX_LIMIT=20
`;

function ensureEnvFile(): string {
  const cwdEnvPath = path.resolve(process.cwd(), ENV_FILE_NAME);
  if (fsSync.existsSync(cwdEnvPath)) {
    return cwdEnvPath;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..");
  const packageTemplatePath = path.resolve(packageRoot, ENV_TEMPLATE_NAME);

  if (fsSync.existsSync(packageTemplatePath)) {
    fsSync.copyFileSync(packageTemplatePath, cwdEnvPath);
    return cwdEnvPath;
  }

  fsSync.writeFileSync(cwdEnvPath, DEFAULT_ENV_TEMPLATE, "utf8");
  return cwdEnvPath;
}

const envFilePath = ensureEnvFile();
dotenv.config({ path: envFilePath });

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
    return 20;
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

function toSafeAttachmentFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  const extension = path.extname(baseName).replace(/[^A-Za-z0-9]/g, "");
  const stem = path.basename(baseName, path.extname(baseName)).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${stem || "download"}${extension ? `.${extension}` : ""}`;
}

const app = express();
const port = Number(process.env.PORT || 3011);
const autoIncrementPort = process.env.AUTO_INCREMENT_PORT !== "false";
const loadExistingMd = process.env.LOAD_EXISTING_MD !== "false";
const excludePatterns = parseExcludePatterns(process.env.EXCLUDE_PATTERN);
const fileMaxLimit = parseFileMaxLimit(process.env.FILE_MAX_LIMIT);
const cwd = process.cwd();
const roots = defaultRoots(cwd);
const index = new MarkdownIndex(roots, loadExistingMd, excludePatterns);
const execFileAsync = promisify(execFile);
const changeClients = new Set<Response>();
const sessionChangeClients = new Set<Response>();
let sessionCache: SessionInfo[] | null = null;
const currentFile = fileURLToPath(import.meta.url);
const webDir = path.resolve(path.dirname(currentFile), "../web");
const saveRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many save requests, please retry shortly" }
});
const gitDiffRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many git diff requests, please retry shortly" }
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(webDir));

function registerSseClient(clients: Set<Response>, _req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

function broadcastSse(clients: Set<Response>, data: string): void {
  for (const client of clients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

async function resolveSession(sessionId: string): Promise<SessionInfo | undefined> {
  const sessions = await getCachedSessions();
  return sessions.find((s) => s.id === sessionId);
}

app.get("/api/files", (_req, res) => {
  res.json(index.list().slice(0, fileMaxLimit).map((entry) => ({
    ...entry,
    path: toDisplayPath(entry.path)
  })));
});

app.get("/api/git-diff", gitDiffRateLimiter, async (_req, res) => {
  // Prevent caching of potentially sensitive git diff data
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache"
  });
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], { cwd, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" });
    res.json({ diff: stdout });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
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
    const fileName = toSafeAttachmentFileName(`${path.basename(filePath, ".md")}.docx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/files/:id/md", async (req, res) => {
  const filePath = index.resolve(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  try {
    const markdown = await fs.readFile(filePath, "utf8");
    const fileName = toSafeAttachmentFileName(path.basename(filePath));
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(markdown);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.put("/api/files/:id", saveRateLimiter, async (req, res) => {
  const filePath = index.resolve(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const markdown = req.body?.markdown;
  const baseMarkdown = req.body?.baseMarkdown;
  if (typeof markdown !== "string") {
    res.status(400).json({ error: "Field 'markdown' must be a string" });
    return;
  }
  if (baseMarkdown !== undefined && typeof baseMarkdown !== "string") {
    res.status(400).json({ error: "Field 'baseMarkdown' must be a string when provided" });
    return;
  }
  try {
    const currentMarkdown = await fs.readFile(filePath, "utf8");
    if (typeof baseMarkdown === "string" && baseMarkdown !== currentMarkdown) {
      res.status(409).json({
        error: "Conflict: file changed on disk",
        path: toDisplayPath(filePath),
        markdown: currentMarkdown,
        html: renderMarkdown(currentMarkdown)
      });
      return;
    }
    await fs.writeFile(filePath, markdown, "utf8");
    res.json({ path: toDisplayPath(filePath), markdown, html: renderMarkdown(markdown) });
  } catch (error) {
    console.error("Failed to save markdown file", error);
    res.status(500).json({ error: "Failed to save file" });
  }
});

app.get("/api/changes", (req, res) => {
  registerSseClient(changeClients, req, res);
});

index.onChange(() => {
  sessionCache = null;
  broadcastSse(changeClients, "changed");
  broadcastSse(sessionChangeClients, "changed");
});

async function getCachedSessions(): Promise<SessionInfo[]> {
  if (!sessionCache) {
    sessionCache = await discoverSessions(index.paths());
  }
  return sessionCache;
}

app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await getCachedSessions();
    res.json(
      sessions.map((s) => ({
        id: s.id,
        title: s.title,
        directory: toDisplayPath(s.directory),
        tables: s.tables
      }))
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await resolveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const data = getAllSessionData(session);
    res.json({
      id: session.id,
      title: session.title,
      directory: toDisplayPath(session.directory),
      tables: session.tables,
      data
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/:table", async (req, res) => {
  try {
    const session = await resolveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!session.tables.includes(req.params.table)) {
      res.status(404).json({ error: "Table not found" });
      return;
    }
    const rows = getSessionTableData(session, req.params.table);
    res.json({ table: req.params.table, rows });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/session-changes", (req, res) => {
  registerSseClient(sessionChangeClients, req, res);
});

async function start(): Promise<void> {
  await index.start();
  let runningPort = port;
  let httpServer: Server | undefined;
  try {
    while (true) {
      const result = await new Promise<{ started: boolean; server: Server }>((resolve, reject) => {
        const server = createServer(app);
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (autoIncrementPort && error.code === "EADDRINUSE") {
            resolve({ started: false, server });
            return;
          }
          reject(error);
        });
        server.listen(runningPort, () => resolve({ started: true, server }));
      });
      if (result.started) {
        httpServer = result.server;
        break;
      }
      if (runningPort >= 65_535) {
        throw Object.assign(new Error(`No available port found between ${port} and 65535`), { code: "EADDRINUSE" });
      }
      runningPort += 1;
    }
  } catch (error) {
    await index.stop();
    const startError = error as NodeJS.ErrnoException;
    if (startError.code === "EADDRINUSE") {
      console.error(startError.message);
    } else {
      console.error(`Failed to start server: ${startError.message}`);
    }
    process.exit(1);
    return;
  }

  const shutdown = async () => {
    console.log("\nShutting down…");
    httpServer?.close();
    await index.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (autoIncrementPort && runningPort !== port) {
    console.log(`Requested port ${port} was in use, using port ${runningPort} instead.`);
  }
  console.log(`Server running on http://localhost:${runningPort}`);
  console.log(`Config loaded from ${envFilePath}`);
  console.log(`AUTO_INCREMENT_PORT=${String(autoIncrementPort)}`);
  console.log(`LOAD_EXISTING_MD=${String(loadExistingMd)}`);
  console.log(`EXCLUDE_PATTERN=${excludePatterns.join(",") || "(none)"}`);
  console.log(`FILE_MAX_LIMIT=${String(fileMaxLimit)}`);
  console.log(`Watching roots:\n- ${roots.join("\n- ")}`);
}

void start();
