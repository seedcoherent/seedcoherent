/**
 * Tests for the browser playground's preview entry (`generatePreview`) — the
 * in-process, Node-free path the client-side playground (issue #48) bundles.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generatePreview,
  PreviewError,
  MAX_ROWS_PER_TABLE,
  MAX_ROWS_TOTAL,
  type PreviewDialect,
} from "../src/preview.js";
import { DEMO_SCHEMA_DDL } from "../src/demo.js";

/** Postgres schema with explicit (non-serial) PKs so ids appear in emitted rows. */
const PG_DDL = `
  CREATE TABLE users (
    id    INT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    plan  TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise'))
  );
  CREATE TABLE orders (
    id      INT PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    total   NUMERIC(10, 2) NOT NULL
  );
`;

function tableByName(
  result: {
    tables: { table: { name: string }; rows: Record<string, unknown>[] }[];
  },
  name: string,
) {
  const t = result.tables.find((t) => t.table.name === name);
  assert.ok(t, `expected a generated table named ${name}`);
  return t;
}

test("generates referentially-coherent rows: child FKs point at real parents", () => {
  const result = generatePreview(PG_DDL, {
    dialect: "postgres",
    rows: { users: 5, orders: 12 },
    seed: 42,
  });
  const users = tableByName(result, "users");
  const orders = tableByName(result, "orders");
  assert.equal(users.rows.length, 5);
  assert.equal(orders.rows.length, 12);

  const userIds = new Set(users.rows.map((r) => r.id));
  for (const o of orders.rows) {
    assert.ok(
      userIds.has(o.user_id),
      `orders.user_id ${o.user_id} is not a real users.id`,
    );
  }
});

test("UNIQUE columns are distinct and CHECK-IN columns use declared values", () => {
  const result = generatePreview(PG_DDL, {
    dialect: "postgres",
    rows: { users: 20, orders: 0 },
    seed: 7,
  });
  const users = tableByName(result, "users");
  const emails = users.rows.map((r) => r.email);
  assert.equal(new Set(emails).size, emails.length, "emails must be unique");
  for (const r of users.rows) {
    assert.ok(["free", "pro", "enterprise"].includes(r.plan as string));
  }
});

test("seeded runs are reproducible", () => {
  const opts = {
    dialect: "postgres" as const,
    rows: { users: 4, orders: 6 },
    seed: 99,
  };
  const a = generatePreview(PG_DDL, opts);
  const b = generatePreview(PG_DDL, opts);
  assert.deepEqual(
    a.tables.map((t) => t.rows),
    b.tables.map((t) => t.rows),
  );
});

test("caps clamp per-table and total row counts", () => {
  const result = generatePreview(PG_DDL, {
    dialect: "postgres",
    defaultRows: 100_000,
    seed: 1,
  });
  assert.equal(result.clamped, true);
  let total = 0;
  for (const t of result.tables) {
    assert.ok(
      t.rows.length <= MAX_ROWS_PER_TABLE,
      `${t.table.name} over per-table cap`,
    );
    total += t.rows.length;
  }
  assert.ok(total <= MAX_ROWS_TOTAL, "total over cap");
});

test("modest counts are not clamped", () => {
  const result = generatePreview(PG_DDL, {
    dialect: "postgres",
    rows: { users: 3, orders: 3 },
    seed: 1,
  });
  assert.equal(result.clamped, false);
});

test("each dialect parses and generates", () => {
  const cases: Array<{ dialect: PreviewDialect; ddl: string }> = [
    { dialect: "sqlite", ddl: DEMO_SCHEMA_DDL },
    { dialect: "postgres", ddl: PG_DDL },
    {
      dialect: "mysql",
      ddl: "CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE);",
    },
    {
      dialect: "sqlserver",
      ddl: "CREATE TABLE users (id INT PRIMARY KEY, email NVARCHAR(255) NOT NULL UNIQUE);",
    },
  ];
  for (const { dialect, ddl } of cases) {
    const result = generatePreview(ddl, { dialect, defaultRows: 3, seed: 5 });
    assert.ok(result.tables.length > 0, `${dialect}: no tables generated`);
    for (const t of result.tables)
      assert.ok(t.rows.length > 0, `${dialect}.${t.table.name} empty`);
  }
});

test("empty input throws a friendly PreviewError", () => {
  assert.throws(
    () => generatePreview("   ", { dialect: "postgres" }),
    PreviewError,
  );
});

test("DDL with no CREATE TABLE throws", () => {
  assert.throws(
    () => generatePreview("SELECT 1;", { dialect: "postgres" }),
    PreviewError,
  );
});

test("unsatisfiable NOT NULL FK (parent has no rows) throws", () => {
  assert.throws(
    () =>
      generatePreview(PG_DDL, {
        dialect: "postgres",
        rows: { users: 0, orders: 5 },
      }),
    PreviewError,
  );
});
