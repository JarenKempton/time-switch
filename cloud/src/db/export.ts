const INTERNAL_TABLE = /^(sqlite_|_cf_|__)/;

export interface DatabaseExport {
  exportedAt: string;
  tables: Record<string, Record<string, SqlStorageValue>[]>;
}

export function exportDatabase(sql: SqlStorage): DatabaseExport {
  const names = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name)
    .filter((name) => !INTERNAL_TABLE.test(name));
  return {
    exportedAt: new Date().toISOString(),
    tables: Object.fromEntries(
      names.map((name) => [
        name,
        sql.exec(`SELECT * FROM "${name}" ORDER BY rowid`).toArray(),
      ]),
    ),
  };
}
