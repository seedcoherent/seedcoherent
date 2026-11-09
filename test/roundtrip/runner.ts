/**
 * Shared round-trip runner. Given an engine and a single DDL-applied database
 * handle, it:
 *
 *   1. introspects the `rt` table back into a Schema,
 *   2. generates N rows deterministically (`--seed 42`),
 *   3. loads that one `data` set into the SAME database two ways, in sequence —
 *      the live-insert path, read back, then `reset()` and the SQL-script path,
 *      read back,
 *   4. asserts each case's validity rule on BOTH paths, plus that the two paths
 *      stored byte-equivalent values (parity).
 *
 * Both load paths target one database, so the schema/table names the SQL-script
 * emits always resolve. Both consume the *same* generated `data`, so any
 * difference is a bug in a literal/insert path (the class the MySQL datetime and
 * PG array bugs belonged to), not in generation.
 */

import assert from "node:assert/strict";
import { topoSort } from "../../src/graph.js";
import { buildData } from "../../src/generate.js";
import type { Schema, TableInfo } from "../../src/types.js";
import type { TableData } from "../../src/generate.js";
import { casesFor, type Engine } from "./fixtures.js";

export const ROW_COUNT = 60;

/** Per-test timeout (ms). A backstop so a stuck connection aborts fast, never hangs CI. */
export const TEST_TIMEOUT_MS = 120_000;

/** One database preloaded with the `rt` schema, driving both load paths. */
export interface RtDb {
  introspect(): Promise<Schema>;
  /** Insert `data` through the production live-insert path. */
  insertLive(data: TableData[]): Promise<void>;
  /** Render `data` to a SQL script and load it. */
  loadScript(data: TableData[]): Promise<void>;
  /** Empty the `rt` table between the two load paths. */
  reset(): Promise<void>;
  /** Read one column's values for every row, ordered by the `id` PK. */
  read(column: string): Promise<unknown[]>;
  /** Tear down. MUST always release the underlying connection, even on error. */
  close(): Promise<void>;
}

/** Normalize a stored value so the two load paths compare structurally. */
function norm(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

/**
 * Run the full type-matrix round-trip for one engine. `makeDb` returns a fresh
 * database with the `rt` schema already applied.
 */
export async function runRoundTrip(
  engine: Engine,
  makeDb: () => Promise<RtDb>,
): Promise<void> {
  const cases = casesFor(engine);
  assert.ok(cases.length > 0, `no round-trip cases for ${engine}`);

  const db = await makeDb();
  try {
    const schema = await db.introspect();
    const table: TableInfo | undefined = [...schema.tables.values()][0];
    assert.ok(table, "introspect did not find the rt table");

    const { order, cyclic } = topoSort(schema);
    const data = buildData(schema, order, cyclic, {
      rows: { [table.key]: ROW_COUNT },
      seed: 42,
    });

    // Path 1: live insert, read every column back.
    await db.insertLive(data);
    const liveVals = new Map<string, unknown[]>();
    for (const c of cases) liveVals.set(c.name, await db.read(c.name));

    // Path 2: reset, load the SQL script, read every column back.
    await db.reset();
    await db.loadScript(data);

    for (const c of cases) {
      const live = liveVals.get(c.name)!;
      const script = await db.read(c.name);

      assert.equal(
        live.length,
        ROW_COUNT,
        `${c.name}: expected ${ROW_COUNT} rows via live insert`,
      );
      assert.equal(
        script.length,
        ROW_COUNT,
        `${c.name}: expected ${ROW_COUNT} rows via script`,
      );

      c.check(live, engine);
      c.check(script, engine);

      if (c.parityToleranceMs != null) {
        for (let i = 0; i < live.length; i++) {
          const a = new Date(live[i] as string).getTime();
          const b = new Date(script[i] as string).getTime();
          assert.ok(
            Number.isFinite(a) && Number.isFinite(b),
            `${c.name}: non-parseable timestamp at row ${i} (${engine})`,
          );
          assert.ok(
            Math.abs(a - b) <= c.parityToleranceMs,
            `${c.name}: timestamp parity drift ${a - b}ms at row ${i} ` +
              `(tolerance ${c.parityToleranceMs}ms, ${engine})`,
          );
        }
      } else {
        assert.deepEqual(
          live.map(norm),
          script.map(norm),
          `${c.name}: script↔live parity (${engine})`,
        );
      }
    }
  } finally {
    await db.close();
  }
}
