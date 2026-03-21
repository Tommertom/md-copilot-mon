import express, { type Response } from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  envFilePath,
  port,
  autoIncrementPort,
  loadExistingMd,
  excludePatterns,
  fileMaxLimit,
  copilotModels,
  copilotDefaultModel,
  copilotFlags
} from "./config.js";
import { registerSseClient, broadcastSse } from "./sse.js";
import { discoverSessions, type SessionInfo } from "./session-store.js";
import { defaultRoots, MarkdownIndex } from "./watcher.js";
import { createFilesRouter } from "./routes/files.js";
import { createGitRouter } from "./routes/git.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createIssuesRouter } from "./routes/issues.js";

const cwd = process.cwd();
const roots = defaultRoots(cwd);
const index = new MarkdownIndex(roots, loadExistingMd, excludePatterns);
const changeClients = new Set<Response>();
const sessionChangeClients = new Set<Response>();
let sessionCache: SessionInfo[] | null = null;

async function getCachedSessions(): Promise<SessionInfo[]> {
  if (!sessionCache) {
    sessionCache = await discoverSessions(index.list().map((entry) => entry.path), index.sessionDirectories());
  }
  return sessionCache;
}

index.onChange(() => {
  sessionCache = null;
  broadcastSse(changeClients, "data: changed\n\n");
  broadcastSse(sessionChangeClients, "data: changed\n\n");
});

const currentFile = fileURLToPath(import.meta.url);
const webDir = path.resolve(path.dirname(currentFile), "../web");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(webDir));

app.use("/api/files", createFilesRouter({ index, fileMaxLimit, copilotFlags }));
app.use("/api", createGitRouter({ getCachedSessions, cwd }));
app.use("/api", createSessionsRouter({ getCachedSessions, copilotModels, copilotDefaultModel, copilotFlags }));
app.use("/api", createIssuesRouter({ cwd, copilotDefaultModel, copilotFlags }));

app.get("/api/frontend-config", (_req, res) => {
  res.json({ models: copilotModels, defaultModel: copilotDefaultModel });
});

app.get("/api/changes", (_req, res) => {
  registerSseClient(res, changeClients);
});

app.get("/api/session-changes", (_req, res) => {
  registerSseClient(res, sessionChangeClients);
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
