/**
 * Shared round-trip runner. Given an engine and a factory that produces a fresh,
 * DDL-applied database handle, it:
 *
 *   1. introspects the `rt` table back into a Schema,
 *   2. generates N rows deterministically (`--seed 42`),
 *   3. loads that one `data` set two ways — the live-insert path and the
 *      SQL-script path — into two independent databases,
 *   4. reads every column back and asserts each case's validity rule on BOTH
 *      paths, plus that the two paths stored byte-equivalent values (parity).
 *
 * Both load paths consume the *same* generated `data`, so any difference is a
 * bug in a literal/insert path (the class the MySQL datetime and PG array bugs
 * belonged to), not in generation.
 */

import assert from "node:assert/strict";
import { topoSort } from "../../src/graph.js";
import { buildData } from "../../src/generate.js";
import type { Schema, TableInfo } from "../../src/types.js";
import type { TableData } from "../../src/generate.js";
import { casesFor, type Engine } from "./fixtures.js";

export const ROW_COUNT = 60;

/** A database preloaded with the `rt` schema, for one load path. */
export interface RtDb {
  introspect(): Promise<Schema>;
  /** Insert `data` through the production live-insert path. */
  insertLive(data: TableData[]): Promise<void>;
  /** Render `data` to a SQL script and load it. */
  loadScript(data: TableData[]): Promise<void>;
  /** Read one column's values for every row, ordered by the `id` PK. */
  read(column: string): Promise<unknown[]>;
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
 * Run the full type-matrix round-trip for one engine. `makeDb` must return a
 * brand-new database each call with the `rt` schema already applied.
 */
export async function runRoundTrip(
  engine: Engine,
  makeDb: () => Promise<RtDb>,
): Promise<void> {
  const cases = casesFor(engine);
  assert.ok(cases.length > 0, `no round-trip cases for ${engine}`);

  const live = await makeDb();
  try {
    const schema = await live.introspect();
    const table: TableInfo | undefined = [...schema.tables.values()][0];
    assert.ok(table, "introspect did not find the rt table");

    const { order, cyclic } = topoSort(schema);
    const data = buildData(schema, order, cyclic, {
      rows: { [table.key]: ROW_COUNT },
      seed: 42,
    });

    await live.insertLive(data);

    const script = await makeDb();
    try {
      await script.loadScript(data);

      for (const c of cases) {
        const liveVals = await live.read(c.name);
        const scriptVals = await script.read(c.name);

        assert.equal(
          liveVals.length,
          ROW_COUNT,
          `${c.name}: expected ${ROW_COUNT} rows via live insert`,
        );
        assert.equal(
          scriptVals.length,
          ROW_COUNT,
          `${c.name}: expected ${ROW_COUNT} rows via script`,
        );

        c.check(liveVals, engine);
        c.check(scriptVals, engine);

        assert.deepEqual(
          liveVals.map(norm),
          scriptVals.map(norm),
          `${c.name}: script↔live parity (${engine})`,
        );
      }
    } finally {
      await script.close();
    }
  } finally {
    await live.close();
  }
}
