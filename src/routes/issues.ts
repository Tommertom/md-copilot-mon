import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toDisplayPath, formatCopilotCmd } from "../util.js";
import { issueRateLimiter } from "../rate-limiters.js";

const execFileAsync = promisify(execFile);

export type IssuesRouterDeps = {
  cwd: string;
  copilotFlags: readonly string[];
};

export function createIssuesRouter(deps: IssuesRouterDeps): Router {
  const { cwd, copilotFlags } = deps;
  const router = Router();

  router.post("/issues", issueRateLimiter, async (req, res) => {
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
    const prompt = `Create a GitHub issue in the current repository with the following details. Title: "${safeTitle}".${bodySection}\n\nRefine the description using your knowledge of the project and where needed, add clarifying questions to the description. Use the gh CLI to create the issue and output the resulting issue URL.`;
    const issueArgs = ["-p", prompt, ...copilotFlags];
    console.log(`[issue] Spawning: ${formatCopilotCmd(issueArgs)} (cwd="${toDisplayPath(cwd)}")`);
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

  return router;
}
