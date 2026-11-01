/** Tests that the SQLite subset fetcher builds the right `?`-parameterized SQL. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteRowFetcher } from "../src/sqlite-subset.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

class RecordingConn implements Connection {
  calls: { sql: string; params?: unknown[] }[] = [];
  /** Stub for ensureSeedFn — records UDF registration attempts. */
  db = {
    registeredFns: [] as string[],
    function(name: string, _opts: unknown, _fn: unknown) {
      this.registeredFns.push(name);
    },
  };

  async query<T = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [] as T[] };
  }
  async end() {}
}

const users = table("users", {
  columns: [col("id", { udtName: "int" }), col("email")],
  primaryKey: ["id"],
});

test("fetchRoots orders by PK and binds the limit", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchRoots(users, 25);
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "users" ORDER BY "id" LIMIT ?`,
  );
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchRoots splices a WHERE predicate before ORDER BY/LIMIT", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchRoots(users, 25, "total > 100");
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "users" WHERE total > 100 ORDER BY "id" LIMIT ?`,
  );
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchRoots uses RANDOM() when sampling without a seed", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchRoots(users, 25, undefined, true);
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "users" ORDER BY RANDOM() LIMIT ?`,
  );
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchRoots uses seedhash UDF when sampling with a seed", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchRoots(users, 25, undefined, true, 7);
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "users" ORDER BY seedhash(?, "id") LIMIT ?`,
  );
  assert.deepEqual(conn.calls[0].params, ["7", 25]);
});

test("seedhash UDF is registered exactly once across multiple seeded calls", async () => {
  const conn = new RecordingConn();
  const fetcher = new SqliteRowFetcher(conn);
  await fetcher.fetchRoots(users, 10, undefined, true, 1);
  await fetcher.fetchRoots(users, 10, undefined, true, 2);
  assert.equal(conn.db.registeredFns.filter((n) => n === "seedhash").length, 1);
});

test("countRows counts all rows without a filter", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).countRows(users);
  assert.equal(conn.calls[0].sql, `SELECT COUNT(*) AS c FROM "users"`);
});

test("countRows splices a WHERE predicate", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).countRows(users, "total > 100");
  assert.equal(
    conn.calls[0].sql,
    `SELECT COUNT(*) AS c FROM "users" WHERE total > 100`,
  );
});

test("fetchByKeys uses IN (...) for a single-column key", async () => {
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchByKeys(users, ["id"], [[1], [2], [3]]);
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "users" WHERE "id" IN (?, ?, ?)`,
  );
  assert.deepEqual(conn.calls[0].params, [1, 2, 3]);
});

test("fetchByKeys uses a row-value IN list for composite keys", async () => {
  const membership = table("membership", {
    columns: [
      col("org_id", { udtName: "int" }),
      col("user_id", { udtName: "int" }),
    ],
    primaryKey: ["org_id", "user_id"],
  });
  const conn = new RecordingConn();
  await new SqliteRowFetcher(conn).fetchByKeys(
    membership,
    ["org_id", "user_id"],
    [
      [1, 10],
      [2, 20],
    ],
  );
  assert.equal(
    conn.calls[0].sql,
    `SELECT * FROM "membership" WHERE ("org_id", "user_id") IN ((?, ?), (?, ?))`,
  );
  assert.deepEqual(conn.calls[0].params, [1, 10, 2, 20]);
});

test("fetchByKeys returns nothing for an empty key set without querying", async () => {
  const conn = new RecordingConn();
  const rows = await new SqliteRowFetcher(conn).fetchByKeys(users, ["id"], []);
  assert.deepEqual(rows, []);
  assert.equal(conn.calls.length, 0);
});

test("fetchByKeys chunks keys in batches of 500", async () => {
  const conn = new RecordingConn();
  // 501 keys → 2 queries
  const keys = Array.from({ length: 501 }, (_, i) => [i]);
  await new SqliteRowFetcher(conn).fetchByKeys(users, ["id"], keys);
  assert.equal(conn.calls.length, 2);
  // First batch: 500 placeholders
  assert.ok(conn.calls[0].sql.includes("IN ("));
  assert.equal((conn.calls[0].params as unknown[]).length, 500);
  // Second batch: 1 placeholder
  assert.equal((conn.calls[1].params as unknown[]).length, 1);
});
