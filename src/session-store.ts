import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { toBase64Id, extractFirstHeading } from "./util.js";

export type WorkspaceInfo = {
  id: string;
  cwd: string;
  summary: string;
  summary_count: number;
  created_at: string;
  updated_at: string;
};

export type SessionInfo = {
  id: string;
  directory: string;
  title: string;
  sqliteFile?: string;
  tables: string[];
  workspace?: WorkspaceInfo;
};

export type SessionTodo = Record<string, unknown>;

function findSessionStateDir(filePath: string): string | undefined {
  const parts = filePath.split(path.sep);
  const idx = parts.indexOf("session-state");
  if (idx < 0 || idx + 1 >= parts.length) {
    return undefined;
  }
  return parts.slice(0, idx + 2).join(path.sep);
}

async function findSqliteFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".db") || entry.name.endsWith(".sqlite"))
      )
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function readWorkspaceYaml(dir: string): Promise<WorkspaceInfo | undefined> {
  const yamlPath = path.join(dir, "workspace.yml");
  try {
    const content = await fs.readFile(yamlPath, "utf8");
    const parsed = yaml.load(content);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const obj = parsed as Record<string, unknown>;
      const rawId = obj.id;
      if (typeof rawId !== "string" || rawId.trim() === "") {
        return undefined;
      }
      const toISOString = (val: unknown): string => {
        if (val instanceof Date) return val.toISOString();
        return String(val ?? "");
      };
      return {
        id: rawId,
        cwd: String(obj.cwd ?? ""),
        summary: String(obj.summary ?? ""),
        summary_count: Number.isFinite(Number(obj.summary_count)) ? Number(obj.summary_count) : 0,
        created_at: toISOString(obj.created_at),
        updated_at: toISOString(obj.updated_at),
      };
    }
  } catch {
    // workspace.yml may not exist or may be unreadable
  }
  return undefined;
}

function readTables(dbPath: string): string[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function readTableRows(
  dbPath: string,
  tableName: string,
  knownTables: string[]
): SessionTodo[] {
  if (!knownTables.includes(tableName)) {
    return [];
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const safeName = tableName.replace(/"/g, '""');
    return db.prepare(`SELECT * FROM "${safeName}"`).all() as SessionTodo[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export async function discoverSessions(
  trackedFilePaths: string[]
): Promise<SessionInfo[]> {
  const sessionDirs = new Set<string>();
  for (const filePath of trackedFilePaths) {
    const sessionDir = findSessionStateDir(filePath);
    if (sessionDir) {
      sessionDirs.add(sessionDir);
    }
  }

  const sessions: SessionInfo[] = [];
  for (const dir of sessionDirs) {
    const sqliteFiles = await findSqliteFiles(dir);
    const workspace = await readWorkspaceYaml(dir);
    if (sqliteFiles.length === 0 && !workspace) {
      continue;
    }
    sqliteFiles.sort();
    const sqliteFile = sqliteFiles.length > 0 ? sqliteFiles[0] : undefined;
    const tables = sqliteFile ? readTables(sqliteFile) : [];
    const dirName = path.basename(dir);

    let title = workspace?.summary || dirName;
    try {
      const mdFiles = (await fs.readdir(dir))
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .sort();
      if (mdFiles.length > 0) {
        const content = await fs.readFile(path.join(dir, mdFiles[0]), "utf8");
        const heading = extractFirstHeading(content);
        if (heading) {
          title = heading;
        }
      }
    } catch {
      /* ignore */
    }

    sessions.push({
      id: toBase64Id(dir),
      directory: dir,
      title,
      sqliteFile,
      tables,
      workspace,
    });
  }

  return sessions.sort((a, b) => a.title.localeCompare(b.title));
}

export function getSessionTableData(
  sessionInfo: SessionInfo,
  tableName: string
): SessionTodo[] {
  if (!sessionInfo.sqliteFile) return [];
  return readTableRows(sessionInfo.sqliteFile, tableName, sessionInfo.tables);
}

export function getAllSessionData(
  sessionInfo: SessionInfo
): Record<string, SessionTodo[]> {
  const result: Record<string, SessionTodo[]> = {};
  if (!sessionInfo.sqliteFile || sessionInfo.tables.length === 0) return result;
  let db: Database.Database | undefined;
  try {
    db = new Database(sessionInfo.sqliteFile, { readonly: true, fileMustExist: true });
    for (const table of sessionInfo.tables) {
      const safeName = table.replace(/"/g, '""');
      try {
        result[table] = db.prepare(`SELECT * FROM "${safeName}"`).all() as SessionTodo[];
      } catch {
        result[table] = [];
      }
    }
  } catch {
    for (const table of sessionInfo.tables) {
      result[table] = [];
    }
  } finally {
    db?.close();
  }
  return result;
}
