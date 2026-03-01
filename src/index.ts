import rateLimit from "express-rate-limit";
import express, { type Response } from "express";
import dotenv from "dotenv";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { markdownToDocx, renderMarkdown } from "./markdown.js";
import { discoverSessions, getAllSessionData, getSessionEvents, getSessionTableData, type SessionInfo, type WorkspaceInfo } from "./session-store.js";
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

type SessionFileEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

function getSessionFileDirCandidates(session: SessionInfo): string[] {
  const candidates = [path.basename(session.directory)];
  const workspaceId = session.workspace?.id?.trim();
  if (workspaceId) {
    candidates.unshift(workspaceId);
  }
  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

async function resolveSessionDataDir(session: SessionInfo, subDir: string): Promise<string | null> {
  const sessionDataRoot = path.join(os.homedir(), ".copilot", "session-data", subDir);
  for (const candidate of getSessionFileDirCandidates(session)) {
    const candidateDir = path.join(sessionDataRoot, candidate);
    try {
      const stat = await fs.stat(candidateDir);
      if (stat.isDirectory()) {
        return candidateDir;
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

function resolveSessionFileDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "files");
}

function resolveSessionResearchDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "research");
}

function resolveSessionCheckpointsDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "checkpoints");
}

function toPosixRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function collectSessionFiles(
  currentDir: string,
  rootDir: string,
  files: SessionFileEntry[]
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, rootDir, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(fullPath);
    files.push({
      path: toPosixRelativePath(path.relative(rootDir, fullPath)),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
}

function resolveSessionDownloadPath(sessionFileDir: string, relativePath: string): string | null {
  const requestedPath = relativePath.trim();
  if (!requestedPath) {
    return null;
  }
  const absolutePath = path.resolve(sessionFileDir, requestedPath);
  const relativeToBase = path.relative(sessionFileDir, absolutePath);
  if (relativeToBase.startsWith("..") || path.isAbsolute(relativeToBase)) {
    return null;
  }
  return absolutePath;
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
const gitCommitRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many git commit requests, please retry shortly" }
});

function createHttpError(httpStatus: number, message: string): Error & { httpStatus: number } {
  const error = new Error(message) as Error & { httpStatus: number };
  error.httpStatus = httpStatus;
  return error;
}

async function resolveGitCwd(sessionIdRaw: string | undefined): Promise<string> {
  const sessionId = sessionIdRaw?.trim() || "";
  if (!sessionId) {
    return cwd;
  }
  const sessions = await getCachedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) {
    throw createHttpError(404, "Session not found");
  }
  const sessionCwd = session.workspace?.cwd?.trim();
  if (!sessionCwd) {
    throw createHttpError(400, "Session workspace cwd not found");
  }
  return sessionCwd;
}

app.use(express.json({ limit: "5mb" }));
app.use(express.static(webDir));

app.get("/api/files", (_req, res) => {
  res.json(index.list().slice(0, fileMaxLimit).map((entry) => ({
    ...entry,
    path: toDisplayPath(entry.path)
  })));
});

app.get("/api/git-diff", gitDiffRateLimiter, async (req, res) => {
  // Prevent caching of potentially sensitive git diff data
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache"
  });
  try {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const diffCwd = await resolveGitCwd(sessionId);
    const { stdout } = await execFileAsync("git", ["diff", "--no-color"], { cwd: diffCwd, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" });
    res.json({ diff: stdout, diffDirectory: toDisplayPath(diffCwd) });
  } catch (error) {
    const typedError = error as Error & { httpStatus?: number };
    res.status(typedError.httpStatus ?? 500).json({ error: typedError.message });
  }
});

app.post("/api/git-commit", gitCommitRateLimiter, async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Commit message is required" });
    return;
  }
  try {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
    const diffCwd = await resolveGitCwd(sessionId);
    const { stdout } = await execFileAsync("git", ["commit", "-am", message], {
      cwd: diffCwd,
      maxBuffer: 5 * 1024 * 1024,
      encoding: "utf8"
    });
    res.json({
      message: "Commit created successfully",
      output: stdout,
      diffDirectory: toDisplayPath(diffCwd)
    });
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      httpStatus?: number;
    };
    if (typeof typedError.httpStatus === "number") {
      res.status(typedError.httpStatus).json({ error: typedError.message });
      return;
    }
    if (typeof typedError.code === "number") {
      const output = [typedError.stderr, typedError.stdout]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n");
      res.status(400).json({ error: output || typedError.message });
      return;
    }
    res.status(500).json({ error: typedError.message });
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

app.get("/api/changes", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  changeClients.add(res);
  res.on("close", () => {
    changeClients.delete(res);
  });
});

index.onChange(() => {
  sessionCache = null;
  for (const client of changeClients) {
    try {
      client.write("data: changed\n\n");
    } catch {
      changeClients.delete(client);
    }
  }
  for (const client of sessionChangeClients) {
    try {
      client.write("data: changed\n\n");
    } catch {
      sessionChangeClients.delete(client);
    }
  }
});

async function getCachedSessions(): Promise<SessionInfo[]> {
  if (!sessionCache) {
    sessionCache = await discoverSessions(index.list().map((entry) => entry.path));
  }
  return sessionCache;
}

app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await getCachedSessions();
    res.json(
      sessions.map((s, order) => ({
        id: s.id,
        title: s.title,
        directory: toDisplayPath(s.directory),
        tables: s.tables,
        workspace: s.workspace,
        order
      }))
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
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
      workspace: session.workspace,
      data
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/events", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const events = await getSessionEvents(session);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/files", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const sessionFileDir = await resolveSessionFileDir(session);
    if (!sessionFileDir) {
      res.json({ directory: "", files: [] });
      return;
    }
    const files: SessionFileEntry[] = [];
    await collectSessionFiles(sessionFileDir, sessionFileDir, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({
      directory: toDisplayPath(sessionFileDir),
      files
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/files/download", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    const sessionFileDir = await resolveSessionFileDir(session);
    if (!sessionFileDir) {
      res.status(404).json({ error: "Session files directory not found" });
      return;
    }
    const filePath = resolveSessionDownloadPath(sessionFileDir, relativePath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.download(filePath, toSafeAttachmentFileName(path.basename(filePath)));
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(500).json({ error: fsError.message });
  }
});

app.get("/api/sessions/:id/research", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const sessionResearchDir = await resolveSessionResearchDir(session);
    if (!sessionResearchDir) {
      res.json({ directory: "", files: [] });
      return;
    }
    const files: SessionFileEntry[] = [];
    await collectSessionFiles(sessionResearchDir, sessionResearchDir, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({
      directory: toDisplayPath(sessionResearchDir),
      files
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/research/download", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    const sessionResearchDir = await resolveSessionResearchDir(session);
    if (!sessionResearchDir) {
      res.status(404).json({ error: "Session research directory not found" });
      return;
    }
    const filePath = resolveSessionDownloadPath(sessionResearchDir, relativePath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.download(filePath, toSafeAttachmentFileName(path.basename(filePath)));
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(500).json({ error: fsError.message });
  }
});

app.get("/api/sessions/:id/checkpoints", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const sessionCheckpointsDir = await resolveSessionCheckpointsDir(session);
    if (!sessionCheckpointsDir) {
      res.json({ directory: "", files: [] });
      return;
    }
    const files: SessionFileEntry[] = [];
    await collectSessionFiles(sessionCheckpointsDir, sessionCheckpointsDir, files);
    const checkpointFiles = files.filter((file) => file.path.toLowerCase().endsWith(".json"));
    checkpointFiles.sort((a, b) => a.path.localeCompare(b.path));
    res.json({
      directory: toDisplayPath(sessionCheckpointsDir),
      files: checkpointFiles
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/sessions/:id/checkpoints/file", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    const sessionCheckpointsDir = await resolveSessionCheckpointsDir(session);
    if (!sessionCheckpointsDir) {
      res.status(404).json({ error: "Session checkpoints directory not found" });
      return;
    }
    const filePath = resolveSessionDownloadPath(sessionCheckpointsDir, relativePath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }
    const relativeToBase = toPosixRelativePath(path.relative(sessionCheckpointsDir, filePath));
    if (!relativeToBase.toLowerCase().endsWith(".json")) {
      res.status(400).json({ error: "Only .json files are supported" });
      return;
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const content = await fs.readFile(filePath, "utf8");
    res.json({ path: relativeToBase, content });
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.status(500).json({ error: fsError.message });
  }
});

app.get("/api/sessions/:id/:table", async (req, res) => {
  try {
    const sessions = await getCachedSessions();
    const session = sessions.find((s) => s.id === req.params.id);
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

app.get("/api/session-changes", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  sessionChangeClients.add(res);
  res.on("close", () => {
    sessionChangeClients.delete(res);
  });
});

app.get("/api/active-sessions", async (_req, res) => {
  try {
    const sessions = await getCachedSessions();
    const activeIds = sessions
      .filter((s): s is SessionInfo & { workspace: WorkspaceInfo } =>
        !!(s.workspace && typeof s.workspace.id === "string" && s.workspace.id.trim() !== ""))
      .map((s) => s.workspace.id);
    const uniqueIds = [...new Set(activeIds)];
    res.json({ sessions: uniqueIds });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

async function start(): Promise<void> {
  await index.start();
  let runningPort = port;
  try {
    while (true) {
      const started = await new Promise<boolean>((resolve, reject) => {
        const server = createServer(app);
        server.once("error", (error) => {
          const startError = error as NodeJS.ErrnoException;
          if (autoIncrementPort && startError.code === "EADDRINUSE") {
            resolve(false);
            return;
          }
          reject(error);
        });
        server.listen(runningPort, () => resolve(true));
      });
      if (started) {
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
  if (autoIncrementPort && runningPort !== port) {
    console.log(`Requested port ${port} was in use, using port ${runningPort} instead.`);
  }
  console.log(`Config loaded from ${envFilePath}:\n`);
  console.log(`AUTO_INCREMENT_PORT=${String(autoIncrementPort)}`);
  console.log(`LOAD_EXISTING_MD=${String(loadExistingMd)}`);
  console.log(`EXCLUDE_PATTERN=${excludePatterns.join(",") || "(none)"}`);
  console.log(`FILE_MAX_LIMIT=${String(fileMaxLimit)}`);
  console.log(`\nWatching roots:\n- ${roots.join("\n- ")}`);
  const startupUrl = `http://localhost:${runningPort}`;
  // final message should appear last so it's easy to spot and click
  console.log(`\n\x1b[1m\x1b[32mServer running on\x1b[0m \x1b[1m\x1b[4m\x1b[36m${startupUrl}\x1b[0m\n`);
}

void start();
