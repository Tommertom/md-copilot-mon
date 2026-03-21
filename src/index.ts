import rateLimit from "express-rate-limit";
import express, { type Response } from "express";
import dotenv from "dotenv";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
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

# Comma-separated list of extra flags appended to every copilot CLI invocation
# Example: --flag1,--flag2
COPILOT_FLAGS=
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
  const homePrefix = homePath + path.sep;
  if (filePath.startsWith(homePrefix)) {
    return `~/${filePath.slice(homePrefix.length).replaceAll(path.sep, "/")}`;
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
const copilotModels = (process.env.COPILOT_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const copilotFlags = (process.env.COPILOT_FLAGS ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
const cwd = process.cwd();
const roots = defaultRoots(cwd);
const index = new MarkdownIndex(roots, loadExistingMd, excludePatterns);
const execFileAsync = promisify(execFile);
const changeClients = new Set<Response>();
const sessionChangeClients = new Set<Response>();

/** Formats a copilot invocation as a readable command line for logging. */
function formatCopilotCmd(args: readonly string[]): string {
  const parts = ["copilot", ...args.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a))];
  return parts.join(" ");
}

function registerSseClient(res: Response, clientSet: Set<Response>): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  clientSet.add(res);
  res.on("close", () => {
    clientSet.delete(res);
  });
}

function broadcastSse(clientSet: Set<Response>, data: string): void {
  for (const client of clientSet) {
    try {
      client.write(data);
    } catch {
      clientSet.delete(client);
    }
  }
}
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
const promptRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many prompt requests, please retry shortly" }
});
const executePlanRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many execute-plan requests, please retry shortly" }
});
const issueRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many issue requests, please retry shortly" }
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

async function resolveSession(id: string, res: Response): Promise<SessionInfo | null> {
  const sessions = await getCachedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return session;
}
app.use(express.static(webDir));

app.get("/api/frontend-config", (_req, res) => {
  res.json({ models: copilotModels });
});

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
    const childEnv = { ...process.env };
    delete childEnv.NODE_CHANNEL_FD;
    delete childEnv.NODE_UNIQUE_ID;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("git", ["diff", "--no-color"], { cwd: diffCwd, env: childEnv, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" }));
    } catch (error) {
      const execError = error as NodeJS.ErrnoException;
      if (execError.code !== "EBADF") {
        throw error;
      }
      ({ stdout } = await execFileAsync("git", ["-C", diffCwd, "diff", "--no-color"], { env: childEnv, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" }));
    }
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
  registerSseClient(res, changeClients);
});

index.onChange(() => {
  sessionCache = null;
  broadcastSse(changeClients, "data: changed\n\n");
  broadcastSse(sessionChangeClients, "data: changed\n\n");
});

async function getCachedSessions(): Promise<SessionInfo[]> {
  if (!sessionCache) {
    sessionCache = await discoverSessions(index.list().map((entry) => entry.path), index.sessionDirectories());
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
    const events = await getSessionEvents(session);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/sessions/:id/prompt", promptRateLimiter, async (req, res) => {
  const sessionId = req.params.id;
  console.log(`[prompt] Request received for session "${sessionId}"`);
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    console.log(`[prompt] Rejected: prompt is empty`);
    res.status(400).json({ error: "Prompt is required" });
    return;
  }
  if (prompt.length > 10_000) {
    console.log(`[prompt] Rejected: prompt too long (${prompt.length} chars)`);
    res.status(400).json({ error: "Prompt is too long (max 10000 characters)" });
    return;
  }
  if (prompt.includes("\u0000")) {
    console.log(`[prompt] Rejected: prompt contains null bytes`);
    res.status(400).json({ error: "Prompt contains unsupported control characters" });
    return;
  }
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (model.length > 256) {
    console.log(`[prompt] Rejected: model name too long (${model.length} chars)`);
    res.status(400).json({ error: "Model name is too long (max 256 characters)" });
    return;
  }
  if (model.includes("\u0000")) {
    console.log(`[prompt] Rejected: model name contains null bytes`);
    res.status(400).json({ error: "Model name contains unsupported control characters" });
    return;
  }
  // When COPILOT_MODELS is configured, only listed models are accepted.
  // When it is empty, the model selector is hidden in the UI and the model
  // parameter is expected to be absent; arbitrary values are not validated
  // so as not to break direct API usage in unconfigured deployments.
  if (model && copilotModels.length > 0 && !copilotModels.includes(model)) {
    console.log(`[prompt] Rejected: model "${model}" not in configured models list`);
    res.status(400).json({ error: "Requested model is not in the configured models list" });
    return;
  }
  console.log(`[prompt] Validated — promptLength=${prompt.length} model=${model || "(default)"}`);
  try {
    const session = await resolveSession(req.params.id, res);
    if (!session) {
      console.log(`[prompt] Rejected: session "${sessionId}" not found`);
      return;
    }
    const sessionCwd = session.workspace?.cwd?.trim();
    if (!sessionCwd) {
      console.log(`[prompt] Rejected: session "${sessionId}" has no workspace cwd`);
      res.status(400).json({ error: "Session workspace cwd not found" });
      return;
    }
    console.log(`[prompt] Session resolved — cwd="${sessionCwd}"`);
    let cwdStats;
    try {
      cwdStats = await fs.stat(sessionCwd);
    } catch (fsError) {
      const typedFsError = fsError as NodeJS.ErrnoException;
      if (typedFsError.code === "ENOENT") {
        console.log(`[prompt] Rejected: workspace directory not found: "${sessionCwd}"`);
        res.status(400).json({ error: "Session workspace directory not found" });
        return;
      }
      throw fsError;
    }
    if (!cwdStats.isDirectory()) {
      console.log(`[prompt] Rejected: workspace path is not a directory: "${sessionCwd}"`);
      res.status(400).json({ error: "Session workspace directory not found" });
      return;
    }
    const copilotArgs = model ? ["-p", prompt, "--model", model, ...copilotFlags] : ["-p", prompt, ...copilotFlags];
    console.log(`[prompt] Spawning: ${formatCopilotCmd(copilotArgs)} (cwd="${sessionCwd}")`);
    const { stdout } = await execFileAsync("copilot", copilotArgs, {
      cwd: sessionCwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      encoding: "utf8"
    });
    console.log(`[prompt] Copilot completed — stdout=${stdout.length} chars`);
    res.json({ output: stdout, directory: toDisplayPath(sessionCwd) });
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typedError.code === "ENOENT") {
      console.error(`[prompt] Error: copilot CLI not found on PATH`);
      res.status(500).json({ error: "Copilot CLI not found on server PATH" });
      return;
    }
    if (typeof typedError.code === "number") {
      console.error(`[prompt] Copilot exited with code ${typedError.code}`);
      if (typedError.stderr) console.error(`[prompt] stderr:\n${typedError.stderr}`);
      if (typedError.stdout) console.error(`[prompt] stdout:\n${typedError.stdout}`);
      const output = [
        typeof typedError.stderr === "string" && typedError.stderr.trim().length > 0
          ? `stderr:\n${typedError.stderr}`
          : "",
        typeof typedError.stdout === "string" && typedError.stdout.trim().length > 0
          ? `stdout:\n${typedError.stdout}`
          : ""
      ]
        .filter((value): value is string => value.length > 0)
        .join("\n");
      res.status(400).json({ error: output || typedError.message });
      return;
    }
    console.error(`[prompt] Unexpected error:`, typedError);
    res.status(500).json({ error: typedError.message });
  }
});

app.get("/api/sessions/:id/files", async (req, res) => {
  try {
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
    const session = await resolveSession(req.params.id, res);
    if (!session) return;
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
  registerSseClient(res, sessionChangeClients);
});

const PLAN_MD_SESSION_RE = /[/\\]\.copilot[/\\]session-state[/\\]([^/\\]+)[/\\]plan\.md$/i;
// UUID v4 pattern for validating session IDs extracted from the path
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post("/api/files/:id/execute-plan", executePlanRateLimiter, (req, res) => {
  const filePath = index.resolve(req.params.id);
  if (!filePath) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const match = filePath.match(PLAN_MD_SESSION_RE);
  if (!match) {
    res.status(400).json({ error: "File is not plan.md inside a .copilot session-state directory" });
    return;
  }
  const sessionId = match[1];
  if (!UUID_RE.test(sessionId)) {
    res.status(400).json({ error: "Invalid session ID format in file path" });
    return;
  }
  const execPlanArgs = ["-p", sessionId, "Execute the plan plan.md", "--tools", "all", "--paths", "/", ...copilotFlags];
  console.log(`[execute-plan] Spawning: ${formatCopilotCmd(execPlanArgs)}`);
  const child = spawn("copilot", execPlanArgs, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (err) => {
    console.error(`Failed to spawn copilot process for session ${sessionId}:`, err.message);
  });
  child.unref();
  res.json({ message: "Plan execution started", sessionId });
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

app.post("/api/issues", issueRateLimiter, async (req, res) => {
  console.log(`[issue] Request received`);
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!title) {
    console.log(`[issue] Rejected: title is empty`);
    res.status(400).json({ error: "Issue title is required" });
    return;
  }
  if (title.length > 256) {
    console.log(`[issue] Rejected: title too long (${title.length} chars)`);
    res.status(400).json({ error: "Issue title is too long (max 256 characters)" });
    return;
  }
  if (body.length > 65_536) {
    console.log(`[issue] Rejected: body too long (${body.length} chars)`);
    res.status(400).json({ error: "Issue body is too long (max 65536 characters)" });
    return;
  }
  if (title.includes("\u0000") || body.includes("\u0000")) {
    console.log(`[issue] Rejected: title or body contains null bytes`);
    res.status(400).json({ error: "Issue contains unsupported control characters" });
    return;
  }
  console.log(`[issue] Validated — title="${title}" bodyLength=${body.length}`);
  const bodySection = body ? `\n\nDescription:\n${body}` : "";
  const safeTitle = title.replaceAll('"', '\\"');
  const prompt = `Create a GitHub issue in the current repository with the following details. Title: "${safeTitle}".${bodySection}\n\nUse the gh CLI to create the issue and output the resulting issue URL.`;
  const issueArgs = ["-p", prompt, ...copilotFlags];
  console.log(`[issue] Spawning: ${formatCopilotCmd(issueArgs)} (cwd="${cwd}")`);
  try {
    const { stdout } = await execFileAsync("copilot", issueArgs, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      encoding: "utf8"
    });
    console.log(`[issue] Copilot completed — stdout=${stdout.length} chars`);
    res.json({ output: stdout });
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typedError.code === "ENOENT") {
      console.error(`[issue] Error: copilot CLI not found on PATH`);
      res.status(500).json({ error: "Copilot CLI not found on server PATH" });
      return;
    }
    if (typeof typedError.code === "number") {
      console.error(`[issue] Copilot exited with code ${typedError.code}`);
      if (typedError.stderr) console.error(`[issue] stderr:\n${typedError.stderr}`);
      if (typedError.stdout) console.error(`[issue] stdout:\n${typedError.stdout}`);
      const output = [
        typeof typedError.stderr === "string" && typedError.stderr.trim().length > 0
          ? `stderr:\n${typedError.stderr}`
          : "",
        typeof typedError.stdout === "string" && typedError.stdout.trim().length > 0
          ? `stdout:\n${typedError.stdout}`
          : ""
      ]
        .filter((value): value is string => value.length > 0)
        .join("\n");
      res.status(400).json({ error: `Copilot CLI exited with error${output ? `:\n${output}` : ""}` });
      return;
    }
    console.error(`[issue] Unexpected error:`, typedError);
    res.status(500).json({ error: (typedError as Error).message });
  }
});

async function start(): Promise<void> {
  try {
    await index.start();
  } catch (error) {
    console.error(`Failed to start file watcher: ${(error as Error).message}`);
    process.exit(1);
  }
  let runningPort = port;
  let server!: ReturnType<typeof createServer>;
  try {
    while (true) {
      const started = await new Promise<boolean>((resolve, reject) => {
        server = createServer(app);
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
  const shutdown = async (): Promise<void> => {
    server.close();
    await index.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  if (autoIncrementPort && runningPort !== port) {
    console.log(`Requested port ${port} was in use, using port ${runningPort} instead.`);
  }
  console.log(`Config loaded from ${envFilePath}:\n`);
  console.log(`AUTO_INCREMENT_PORT=${String(autoIncrementPort)}`);
  console.log(`LOAD_EXISTING_MD=${String(loadExistingMd)}`);
  console.log(`EXCLUDE_PATTERN=${excludePatterns.join(",") || "(none)"}`);
  console.log(`FILE_MAX_LIMIT=${String(fileMaxLimit)}`);
  console.log(`COPILOT_FLAGS=${copilotFlags.join(",") || "(none)"}`);
  console.log(`\nWatching roots:\n- ${roots.join("\n- ")}`);
  const startupUrl = `http://localhost:${runningPort}`;
  // final message should appear last so it's easy to spot and click
  console.log(`\n\x1b[1m\x1b[32mServer running on\x1b[0m \x1b[1m\x1b[4m\x1b[36m${startupUrl}\x1b[0m\n`);
}

void start();
