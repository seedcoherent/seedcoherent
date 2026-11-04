/**
 * Web Worker for the playground: runs generation off the main thread so a large
 * paste never freezes the page. Receives a request, posts back a result the UI
 * can render directly. Imports only the Node-free preview entry.
 */

import {
  generatePreview,
  PreviewError,
  type PreviewOptions,
} from "../../src/preview.js";

export interface WorkerRequest {
  ddl: string;
  options: PreviewOptions;
}

/** A table flattened to plain, structured-clone-safe data for the UI. */
export interface PreviewTableView {
  name: string;
  columns: {
    name: string;
    type: string;
    /** True when this column is (part of) a foreign key — shown with a marker. */
    isForeignKey: boolean;
    references: string | null;
  }[];
  /** Rows as display strings, aligned to `columns`. */
  rows: string[][];
}

export type WorkerResponse =
  | { ok: true; tables: PreviewTableView[]; clamped: boolean }
  | { ok: false; error: string };

/** Render one generated value to a compact display string. */
function display(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { ddl, options } = e.data;
  try {
    const { tables, clamped } = generatePreview(ddl, options);
    const views: PreviewTableView[] = tables.map((t) => {
      const fkCols = new Map<string, string>(); // column name -> "refTable(refCol)"
      for (const fk of t.table.foreignKeys) {
        fk.columns.forEach((col, i) => {
          const refCol = fk.refColumns?.[i] ?? "";
          fkCols.set(col, `${fk.refTable}${refCol ? `(${refCol})` : ""}`);
        });
      }
      return {
        name: t.table.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.udtName,
          isForeignKey: fkCols.has(c.name),
          references: fkCols.get(c.name) ?? null,
        })),
        rows: t.rows.map((r) => t.columns.map((c) => display(r[c.name]))),
      };
    });
    const res: WorkerResponse = { ok: true, tables: views, clamped };
    self.postMessage(res);
  } catch (err) {
    const message =
      err instanceof PreviewError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    const res: WorkerResponse = { ok: false, error: message };
    self.postMessage(res);
  }
};
