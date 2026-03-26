import type { TraulDB } from "../db/database";

const ALLOWED_PREFIXES = ["SELECT", "PRAGMA", "WITH", "EXPLAIN"];
const FORBIDDEN_PATTERN = /;\s*\S/;

interface SqlOptions {
  write?: boolean;
}

export async function runSql(db: TraulDB, query: string, options?: SqlOptions): Promise<Record<string, unknown>[] | { changes: number }> {
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();

  if (!options?.write) {
    if (FORBIDDEN_PATTERN.test(trimmed)) {
      throw new Error("Read-only: multiple statements not allowed");
    }

    const allowed = ALLOWED_PREFIXES.some((p) => upper.startsWith(p));
    if (!allowed) {
      throw new Error(`Read-only: only SELECT, PRAGMA, WITH, and EXPLAIN queries are allowed`);
    }
  }

  const result = await db.execute(trimmed);
  const isRead = ALLOWED_PREFIXES.some((p) => upper.startsWith(p));
  if (isRead) {
    return result.rows as Record<string, unknown>[];
  }

  return { changes: result.rowsAffected };
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface TableInfo {
  name: string;
  type: string;
  columns: ColumnInfo[];
}

export async function runSchema(db: TraulDB): Promise<TableInfo[]> {
  const tablesResult = await db.execute(
    `SELECT name, type FROM sqlite_master
     WHERE (type = 'table' OR type = 'view')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '%_content'
       AND name NOT LIKE '%_idx'
       AND name NOT LIKE '%_data'
       AND name NOT LIKE '%_docsize'
       AND name NOT LIKE '%_config'
     UNION
     SELECT name, type FROM sqlite_master
     WHERE type = 'table' AND name LIKE '%_fts'
     ORDER BY name`
  );
  const tables = tablesResult.rows as unknown as { name: string; type: string }[];

  const result: TableInfo[] = [];
  for (const t of tables) {
    let columns: ColumnInfo[] = [];
    try {
      const colResult = await db.execute(`PRAGMA table_info(${t.name})`);
      columns = colResult.rows as unknown as ColumnInfo[];
    } catch {
      // Virtual tables may not support table_info
    }
    result.push({ name: t.name, type: t.type, columns });
  }
  return result;
}
