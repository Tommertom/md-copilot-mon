import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";

export type SessionInfo = {
  id: string;
  directory: string;
  title: string;
  sqliteFile: string;
  tables: string[];
};

export type SessionTodo = Record<string, unknown>;

function toSessionId(dirPath: string): string {
  return Buffer.from(dirPath, "utf8").toString("base64url");
}

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
  tableName: string
): SessionTodo[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const knownTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    if (!knownTables.some((t) => t.name === tableName)) {
      return [];
    }
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
    if (sqliteFiles.length === 0) {
      continue;
    }
    const sqliteFile = sqliteFiles[0];
    const tables = readTables(sqliteFile);
    const dirName = path.basename(dir);

    let title = dirName;
    try {
      const mdFiles = (await fs.readdir(dir)).filter((f) =>
        f.toLowerCase().endsWith(".md")
      );
      if (mdFiles.length > 0) {
        const content = await fs.readFile(path.join(dir, mdFiles[0]), "utf8");
        const [firstLine = ""] = content.split(/\r?\n/, 1);
        if (firstLine.startsWith("# ")) {
          title = firstLine.slice(2).trim();
        }
      }
    } catch {
      /* ignore */
    }

    sessions.push({
      id: toSessionId(dir),
      directory: dir,
      title,
      sqliteFile,
      tables,
    });
  }

  return sessions.sort((a, b) => a.title.localeCompare(b.title));
}

export function getSessionTableData(
  sessionInfo: SessionInfo,
  tableName: string
): SessionTodo[] {
  return readTableRows(sessionInfo.sqliteFile, tableName);
}

export function getAllSessionData(
  sessionInfo: SessionInfo
): Record<string, SessionTodo[]> {
  const result: Record<string, SessionTodo[]> = {};
  for (const table of sessionInfo.tables) {
    result[table] = readTableRows(sessionInfo.sqliteFile, table);
  }
  return result;
}
