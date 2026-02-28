import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileEntry } from "./types.js";
import { toBase64Id, extractFirstHeading } from "./util.js";

function isMarkdown(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".md");
}

export class MarkdownIndex {
  private readonly byPath = new Map<string, FileEntry>();
  private readonly byId = new Map<string, string>();
  private readonly changeListeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private watcherStopping = false;

  constructor(
    private readonly roots: string[],
    private readonly loadExistingOnStart: boolean,
    private readonly excludePatterns: string[]
  ) { }

  async start(): Promise<void> {
    if (this.loadExistingOnStart) {
      await this.seedExisting();
    }
    this.watcherStopping = false;
    this.watcher = chokidar.watch(this.roots, {
      ignored: (p) => p.includes("/node_modules/") || p.includes("/.git/"),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });
    this.watcher.on("add", (filePath: string) => {
      void this.upsert(filePath).then((changed) => {
        if (changed) this.notifyChanged();
      });
    });
    this.watcher.on("change", (filePath: string) => {
      void this.upsert(filePath).then((changed) => {
        if (changed) this.notifyChanged();
      });
    });
    this.watcher.on("unlink", (filePath: string) => {
      if (this.remove(filePath)) {
        this.notifyChanged();
      }
    });
    this.watcher.on("error", (error: unknown) => {
      const errorWithCode = typeof error === "object" && error !== null
        ? (error as Partial<NodeJS.ErrnoException>)
        : undefined;
      if (errorWithCode?.code === "ENOSPC") {
        if (this.watcherStopping) {
          return;
        }
        this.watcherStopping = true;
        console.error("File watcher limit reached (ENOSPC). Continuing without live file watching.");
        void this.stop().catch((stopError) => console.error("Failed to stop watcher after ENOSPC:", stopError));
        return;
      }
      const message =
        error instanceof Error
          ? error.stack ?? error.message
          : error != null
            ? String(error)
            : "Unknown watcher error";
      console.error("File watcher error:", message);
    });
  }

  private async seedExisting(): Promise<void> {
    await Promise.all(this.roots.map((root) => this.walk(root)));
  }

  private async walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          return;
        }
        await this.walk(fullPath);
        return;
      }
      if (entry.isFile() && isMarkdown(fullPath)) {
        await this.upsert(fullPath);
      }
    }));
  }

  private async upsert(filePath: string): Promise<boolean> {
    if (!isMarkdown(filePath)) {
      return false;
    }
    if (this.isExcluded(filePath)) {
      return this.remove(filePath);
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return false;
      }
      const markdown = await fs.readFile(filePath, "utf8");
      const id = toBase64Id(filePath);
      const previous = this.byPath.get(filePath);
      const entry: FileEntry = { id, path: filePath, title: extractFirstHeading(markdown), mtimeMs: stat.mtimeMs };
      this.byPath.set(filePath, entry);
      this.byId.set(id, filePath);
      return !previous || previous.mtimeMs !== entry.mtimeMs;
    } catch {
      return this.remove(filePath);
    }
  }

  private remove(filePath: string): boolean {
    const existing = this.byPath.get(filePath);
    if (!existing) {
      return false;
    }
    this.byPath.delete(filePath);
    this.byId.delete(existing.id);
    return true;
  }

  list(): FileEntry[] {
    return [...this.byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  paths(): string[] {
    return [...this.byPath.keys()];
  }

  resolve(id: string): string | undefined {
    return this.byId.get(id);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = undefined;
    try {
      if (!watcher) {
        return;
      }
      await watcher.close();
    } finally {
      this.watcherStopping = false;
    }
  }

  private isExcluded(filePath: string): boolean {
    const normalizedPath = filePath.replaceAll("\\", "/");
    return this.excludePatterns.some((pattern) => normalizedPath.includes(pattern));
  }
}

export function defaultRoots(cwd: string): string[] {
  return [cwd, path.join(os.homedir(), ".copilot")];
}
