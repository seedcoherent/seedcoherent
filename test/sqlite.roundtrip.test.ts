/**
 * SQLite type round-trip. Unlike the other engines this needs no external
 * server — better-sqlite3 runs in-process — so it always runs as part of
 * `npm test`, giving the type-matrix harness coverage even on a DB-free machine.
 */

import { test } from "node:test";
import Database from "better-sqlite3";
import { introspectSqlite } from "../src/sqlite-introspect.js";
import { insertDataSqlite, toSqlSqlite } from "../src/sqlite-emit.js";
import type { Connection } from "../src/types.js";
import type { TableData } from "../src/generate.js";
import { casesFor, columnClauses } from "./roundtrip/fixtures.js";
import {
  runRoundTrip,
  TEST_TIMEOUT_MS,
  type RtDb,
} from "./roundtrip/runner.js";

const cases = casesFor("sqlite");
const { preambles, columns } = columnClauses("sqlite", cases);
const DDL = [
  "PRAGMA foreign_keys=ON;",
  ...preambles.map((p) => `${p};`),
  `CREATE TABLE rt (\n  id INTEGER PRIMARY KEY,\n  ${columns.join(",\n  ")}\n);`,
].join("\n");

function makeDb(): Promise<RtDb> {
  const db = new Database(":memory:");
  db.exec(DDL);
  const conn: Connection = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const stmt = db.prepare(sql);
      const args = (params ?? []) as unknown[];
      if (stmt.reader) return { rows: stmt.all(...args) as T[] };
      stmt.run(...args);
      return { rows: [] as T[] };
    },
    async end() {},
  };
  const handle: RtDb = {
    introspect: () => introspectSqlite(conn, ["main"]),
    insertLive: async (data: TableData[]) => {
      await insertDataSqlite(conn, data, {});
    },
    loadScript: async (data: TableData[]) => {
      db.exec(toSqlSqlite(data));
    },
    reset: async () => {
      db.exec("DELETE FROM rt");
    },
    read: async (column: string) =>
      db
        .prepare(`SELECT ${column} AS v FROM rt ORDER BY id`)
        .all()
        .map((r) => (r as { v: unknown }).v),
    close: async () => {
      db.close();
    },
  };
  return Promise.resolve(handle);
}

test(
  "SQLite type round-trip (live insert ↔ SQL script)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await runRoundTrip("sqlite", makeDb);
  },
);
