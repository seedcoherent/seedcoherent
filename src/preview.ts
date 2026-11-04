/**
 * Browser-safe preview entry for the web playground (issue #48).
 *
 * This is the single import surface the client-side playground bundles. It
 * reproduces the core of `runOffline` in `cli.ts` — parse pasted DDL, order the
 * tables, run the same up-front guards, generate rows — but returns structured
 * results instead of calling `program.error`, and caps generation so a huge
 * paste can't hang the tab.
 *
 * It imports only the offline generation chain (`schema-file`, `graph`,
 * `generate`), none of which pulls in a database driver or a Node builtin, so
 * the whole module bundles for the browser. Do NOT import `cli.ts`,
 * `dialect.ts`, `emit.ts`, or `dataformat.ts` from here — those drag in `pg`,
 * `mysql2`, `better-sqlite3`, `mssql`, or `node:` builtins and would break the
 * bundle.
 */

import { loadSchemaFromDdl, type SchemaFileDialect } from "./schema-file.js";
import { topoSort } from "./graph.js";
import {
  buildData,
  rowCount,
  requiredUnsupportedColumns,
  unsatisfiableRequiredFks,
  type TableData,
} from "./generate.js";
import type { Config, TableInfo } from "./types.js";

/** The four engines the playground understands, matching `--schema-file`. */
export type PreviewDialect = SchemaFileDialect;

/** Safety caps so a browser tab never generates an unbounded amount of data. */
export const MAX_ROWS_PER_TABLE = 200;
export const MAX_ROWS_TOTAL = 2000;

export interface PreviewOptions {
  /** DDL grammar to parse (also the four allowed engines). */
  dialect: PreviewDialect;
  /** Fallback row count for tables without an explicit count. */
  defaultRows?: number;
  /** Per-table row counts, keyed by table name (or `schema.name`). */
  rows?: Record<string, number>;
  /** Seed for reproducible output; omit for fresh data each run. */
  seed?: number;
  /** Faker locale, e.g. "en", "de", "fr". Defaults to US English. */
  locale?: string;
}

export interface PreviewResult {
  tables: TableData[];
  /** True when the caps trimmed the requested counts, for a UI notice. */
  clamped: boolean;
}

/** Thrown for any expected, user-facing failure (bad DDL, unsatisfiable FK). */
export class PreviewError extends Error {}

/**
 * Parse DDL and generate coherent sample rows, entirely in-process. Throws
 * {@link PreviewError} with a human-readable message for expected failures
 * (unparsable DDL, no tables, an unsupported required column, an unsatisfiable
 * NOT NULL foreign key) — the same conditions `runOffline` reports — so the
 * playground can render them inline.
 */
export function generatePreview(
  ddl: string,
  options: PreviewOptions,
): PreviewResult {
  if (!ddl.trim()) throw new PreviewError("Paste a CREATE TABLE statement.");

  let schema;
  try {
    schema = loadSchemaFromDdl(ddl, options.dialect);
  } catch (err) {
    throw new PreviewError(
      `Couldn't parse the ${options.dialect} schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (schema.tables.size === 0) {
    throw new PreviewError("No CREATE TABLE statements found in the schema.");
  }

  const { order, cyclic } = topoSort(schema);
  const { config, clamped } = cappedConfig(order, options);

  const skipSet = new Set(config.skip ?? []);
  const genKeys = order
    .filter(
      (t) =>
        !skipSet.has(t.name) && !skipSet.has(t.key) && rowCount(t, config) > 0,
    )
    .map((t) => t.key);

  const unsupported = requiredUnsupportedColumns(schema, config, genKeys);
  if (unsupported.length > 0) {
    const lines = unsupported.map(
      (c) => `  ${c.table}.${c.column} (${c.udtName})`,
    );
    throw new PreviewError(
      [
        `Can't generate a value for ${unsupported.length} NOT NULL column(s) of an unsupported type:`,
        ...lines,
        "",
        "Make the column nullable, give it a DB default, or remove it to preview the rest.",
      ].join("\n"),
    );
  }

  const unsatisfiable = unsatisfiableRequiredFks(schema, order, config);
  if (unsatisfiable.length > 0) {
    const lines = unsatisfiable.map(
      (u) =>
        `  ${u.table} (${u.columns.join(", ")}) → ${u.refTable}` +
        (u.reason === "cycle"
          ? " — NOT NULL FK cycle"
          : " — parent has no rows"),
    );
    throw new PreviewError(
      [
        `Can't satisfy ${unsatisfiable.length} NOT NULL foreign key(s); the parent has no rows when the child is generated:`,
        ...lines,
        "",
        "Make the FK column nullable, give the parent rows, or for a true cycle use a DEFERRABLE constraint.",
      ].join("\n"),
    );
  }

  const tables = buildData(schema, order, cyclic, config);
  return { tables, clamped };
}

/**
 * Builds a {@link Config} whose per-table row counts honor the browser caps:
 * each table is clamped to {@link MAX_ROWS_PER_TABLE}, and if the total still
 * exceeds {@link MAX_ROWS_TOTAL} every table is scaled down to fit (floored, so
 * a table with any rows keeps at least one). Returns whether any clamp applied.
 */
function cappedConfig(
  order: TableInfo[],
  options: PreviewOptions,
): { config: Config; clamped: boolean } {
  const base: Config = {
    rows: options.rows,
    defaultRows: options.defaultRows,
    seed: options.seed,
    locale: options.locale,
  };

  const requested = new Map<string, number>();
  for (const t of order) requested.set(t.key, rowCount(t, base));

  let clamped = false;
  const capped = new Map<string, number>();
  for (const [key, n] of requested) {
    const c = Math.min(n, MAX_ROWS_PER_TABLE);
    if (c !== n) clamped = true;
    capped.set(key, c);
  }

  let total = 0;
  for (const n of capped.values()) total += n;
  if (total > MAX_ROWS_TOTAL) {
    clamped = true;
    const scale = MAX_ROWS_TOTAL / total;
    for (const [key, n] of capped) {
      capped.set(key, n > 0 ? Math.max(1, Math.floor(n * scale)) : 0);
    }
  }

  const rows: Record<string, number> = {};
  for (const [key, n] of capped) rows[key] = n;
  return { config: { ...base, rows }, clamped };
}
