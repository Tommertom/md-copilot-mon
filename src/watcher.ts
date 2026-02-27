import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileEntry } from "./types.js";

function toId(filePath: string): string {
  return Buffer.from(filePath, "utf8").toString("base64url");
}

function isMarkdown(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".md");
}

export class MarkdownIndex {
  private readonly byPath = new Map<string, FileEntry>();
  private readonly byId = new Map<string, string>();
  private watcher?: FSWatcher;

  constructor(
    private readonly roots: string[],
    private readonly loadExistingOnStart: boolean,
    private readonly excludePatterns: string[]
  ) {}

  async start(): Promise<void> {
    if (this.loadExistingOnStart) {
      await this.seedExisting();
    }
    this.watcher = chokidar.watch(this.roots, {
      ignored: (p) => p.includes("/node_modules/") || p.includes("/.git/"),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });
    this.watcher.on("add", (filePath: string) => void this.upsert(filePath));
    this.watcher.on("change", (filePath: string) => void this.upsert(filePath));
    this.watcher.on("unlink", (filePath: string) => this.remove(filePath));
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

  private async upsert(filePath: string): Promise<void> {
    if (!isMarkdown(filePath)) {
      return;
    }
    if (this.isExcluded(filePath)) {
      this.remove(filePath);
      return;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return;
      }
      const id = toId(filePath);
      const entry: FileEntry = { id, path: filePath, mtimeMs: stat.mtimeMs };
      this.byPath.set(filePath, entry);
      this.byId.set(id, filePath);
    } catch {
      this.remove(filePath);
    }
  }

  private remove(filePath: string): void {
    const existing = this.byPath.get(filePath);
    if (!existing) {
      return;
    }
    this.byPath.delete(filePath);
    this.byId.delete(existing.id);
  }

  list(): FileEntry[] {
    return [...this.byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  resolve(id: string): string | undefined {
    return this.byId.get(id);
  }

  private isExcluded(filePath: string): boolean {
    const normalizedPath = filePath.replaceAll("\\", "/");
    return this.excludePatterns.some((pattern) => normalizedPath.includes(pattern));
  }
}

export function defaultRoots(cwd: string): string[] {
  return [cwd, path.join(os.homedir(), ".copilot")];
}
