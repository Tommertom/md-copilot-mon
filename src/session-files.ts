import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "./session-store.js";

export type SessionFileEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

export function toPosixRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function getSessionFileDirCandidates(session: SessionInfo): string[] {
  const candidates = [path.basename(session.directory)];
  const workspaceId = session.workspace?.id?.trim();
  if (workspaceId) {
    candidates.unshift(workspaceId);
  }
  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

export async function resolveSessionDataDir(session: SessionInfo, subDir: string): Promise<string | null> {
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

export function resolveSessionFileDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "files");
}

export function resolveSessionResearchDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "research");
}

export function resolveSessionCheckpointsDir(session: SessionInfo): Promise<string | null> {
  return resolveSessionDataDir(session, "checkpoints");
}

export async function collectSessionFiles(
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

export function resolveSessionDownloadPath(sessionFileDir: string, relativePath: string): string | null {
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
