import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { toBase64Id, extractFirstHeading } from "./util.js";

export type SessionInfo = {
  id: string;
  directory: string;
  title: string;
  sqliteFile: string;
  tables: string[];
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
    if (sqliteFiles.length === 0) {
      continue;
    }
    sqliteFiles.sort();
    const sqliteFile = sqliteFiles[0];
    const tables = readTables(sqliteFile);
    const dirName = path.basename(dir);

    let title = dirName;
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
    });
  }

  return sessions.sort((a, b) => a.title.localeCompare(b.title));
}

export function getSessionTableData(
  sessionInfo: SessionInfo,
  tableName: string
): SessionTodo[] {
  return readTableRows(sessionInfo.sqliteFile, tableName, sessionInfo.tables);
}

export function getAllSessionData(
  sessionInfo: SessionInfo
): Record<string, SessionTodo[]> {
  const result: Record<string, SessionTodo[]> = {};
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
