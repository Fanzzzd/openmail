import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { OpSqliteDatabase, SqliteScalar } from "../src/platform/react-native/sqlite.js";

const bind = (value: SqliteScalar): SQLInputValue => {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};
// Same Promise API and result shapes as op-sqlite, backed by real node:sqlite.
export function opSqliteShim(
  file = ":memory:",
  readOnly = false,
  seed?: (db: DatabaseSync) => void,
): { open: () => OpSqliteDatabase; closed: () => boolean } {
  let closed = false;
  return {
    closed: () => closed,
    open: () => {
      const db = new DatabaseSync(file, { readOnly });
      seed?.(db);
      return {
        execute: async (query, params = []) => {
          const statement = db.prepare(query);
          if (statement.columns().length) {
            // SQLite's declared row result is an IO boundary.
            const rows = statement.all(...params.map(bind)) as Record<string, SqliteScalar>[];
            return { rows, rowsAffected: 0 };
          }
          const result = statement.run(...params.map(bind));
          return {
            rows: [],
            rowsAffected: Number(result.changes),
            insertId: Number(result.lastInsertRowid),
          };
        },
        executeRaw: async (query, params = []) => {
          const statement = db.prepare(query);
          const columns = statement.columns();
          if (!columns.length) {
            const result = statement.run(...params.map(bind));
            return {
              rawRows: [],
              columnNames: [],
              rowsAffected: Number(result.changes),
              insertId: Number(result.lastInsertRowid),
            };
          }
          const rows = statement.all(...params.map(bind)) as Record<string, SqliteScalar>[];
          return {
            rowsAffected: 0,
            columnNames: columns.map((column) => column.name),
            rawRows: rows.map((row) => columns.map((column) => row[column.name] ?? null)),
          };
        },
        close: () => {
          db.close();
          closed = true;
        },
      };
    },
  };
}
