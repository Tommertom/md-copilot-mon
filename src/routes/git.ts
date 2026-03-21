import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionInfo } from "../session-store.js";
import { toDisplayPath } from "../util.js";
import { gitDiffRateLimiter, gitCommitRateLimiter } from "../rate-limiters.js";

const execFileAsync = promisify(execFile);

function createHttpError(httpStatus: number, message: string): Error & { httpStatus: number } {
  const error = new Error(message) as Error & { httpStatus: number };
  error.httpStatus = httpStatus;
  return error;
}

async function resolveGitCwd(
  sessionIdRaw: string | undefined,
  cwd: string,
  getCachedSessions: () => Promise<SessionInfo[]>
): Promise<string> {
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

export type GitRouterDeps = {
  getCachedSessions: () => Promise<SessionInfo[]>;
  cwd: string;
};

export function createGitRouter(deps: GitRouterDeps): Router {
  const { getCachedSessions, cwd } = deps;
  const router = Router();

  router.get("/git-diff", gitDiffRateLimiter, async (req, res) => {
    // Prevent caching of potentially sensitive git diff data
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache"
    });
    try {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const diffCwd = await resolveGitCwd(sessionId, cwd, getCachedSessions);
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

  router.post("/git-commit", gitCommitRateLimiter, async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "Commit message is required" });
      return;
    }
    try {
      const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
      const diffCwd = await resolveGitCwd(sessionId, cwd, getCachedSessions);
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

  return router;
}
