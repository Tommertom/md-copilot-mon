import { Router, type Response } from "express";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  getAllSessionData,
  getSessionEvents,
  getSessionTableData,
  type SessionInfo,
  type WorkspaceInfo
} from "../session-store.js";
import { toDisplayPath, toSafeAttachmentFileName, formatCopilotCmd } from "../util.js";
import {
  collectSessionFiles,
  resolveSessionCheckpointsDir,
  resolveSessionDownloadPath,
  resolveSessionFileDir,
  resolveSessionResearchDir,
  toPosixRelativePath,
  type SessionFileEntry
} from "../session-files.js";
import { promptRateLimiter } from "../rate-limiters.js";

const execFileAsync = promisify(execFile);

export type SessionsRouterDeps = {
  getCachedSessions: () => Promise<SessionInfo[]>;
  copilotModels: readonly string[];
  copilotFlags: readonly string[];
};

async function resolveSession(
  id: string,
  res: Response,
  getCachedSessions: () => Promise<SessionInfo[]>
): Promise<SessionInfo | null> {
  const sessions = await getCachedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return session;
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { getCachedSessions, copilotModels, copilotFlags } = deps;
  const router = Router();

  router.get("/sessions", async (_req, res) => {
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

  router.get("/active-sessions", async (_req, res) => {
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

  router.get("/sessions/:id/events", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
      if (!session) return;
      const events = await getSessionEvents(session);
      res.json(events);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/sessions/:id/prompt", promptRateLimiter, async (req, res) => {
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
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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

  router.get("/sessions/:id/files", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
      if (!session) return;
      const sessionFileDir = await resolveSessionFileDir(session);
      if (!sessionFileDir) {
        res.json({ directory: "", files: [] });
        return;
      }
      const files: SessionFileEntry[] = [];
      await collectSessionFiles(sessionFileDir, sessionFileDir, files);
      files.sort((a, b) => a.path.localeCompare(b.path));
      res.json({ directory: toDisplayPath(sessionFileDir), files });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/sessions/:id/files/download", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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
      res.download(filePath, toSafeAttachmentFileName(filePath));
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.status(500).json({ error: fsError.message });
    }
  });

  router.get("/sessions/:id/research", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
      if (!session) return;
      const sessionResearchDir = await resolveSessionResearchDir(session);
      if (!sessionResearchDir) {
        res.json({ directory: "", files: [] });
        return;
      }
      const files: SessionFileEntry[] = [];
      await collectSessionFiles(sessionResearchDir, sessionResearchDir, files);
      files.sort((a, b) => a.path.localeCompare(b.path));
      res.json({ directory: toDisplayPath(sessionResearchDir), files });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/sessions/:id/research/download", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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
      res.download(filePath, toSafeAttachmentFileName(filePath));
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.status(500).json({ error: fsError.message });
    }
  });

  router.get("/sessions/:id/checkpoints", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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
      res.json({ directory: toDisplayPath(sessionCheckpointsDir), files: checkpointFiles });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/sessions/:id/checkpoints/file", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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

  router.get("/sessions/:id", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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

  // Generic table catch-all — must be last among session sub-routes.
  router.get("/sessions/:id/:table", async (req, res) => {
    try {
      const session = await resolveSession(req.params.id, res, getCachedSessions);
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

  return router;
}
