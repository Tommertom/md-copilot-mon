import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { MarkdownIndex } from "../watcher.js";
import { markdownToDocx, renderMarkdown } from "../markdown.js";
import { toDisplayPath, toSafeAttachmentFileName, formatCopilotCmd } from "../util.js";
import { saveRateLimiter, executePlanRateLimiter } from "../rate-limiters.js";

const PLAN_MD_SESSION_RE = /[/\\]\.copilot[/\\]session-state[/\\]([^/\\]+)[/\\]plan\.md$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FilesRouterDeps = {
  index: MarkdownIndex;
  fileMaxLimit: number;
  copilotFlags: readonly string[];
};

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { index, fileMaxLimit, copilotFlags } = deps;
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(
      index.list().slice(0, fileMaxLimit).map((entry) => ({
        ...entry,
        path: toDisplayPath(entry.path)
      }))
    );
  });

  // Specific sub-paths must be registered before the bare /:id catch-all.
  router.get("/:id/docx", async (req, res) => {
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

  router.get("/:id/md", async (req, res) => {
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

  router.get("/:id", async (req, res) => {
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

  router.put("/:id", saveRateLimiter, async (req, res) => {
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

  router.post("/:id/execute-plan", executePlanRateLimiter, (req, res) => {
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

  return router;
}
