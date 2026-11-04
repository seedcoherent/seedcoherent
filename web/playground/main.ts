/**
 * Playground UI: paste a schema, pick a dialect and row count, see coherent
 * sample rows. Generation runs in a Web Worker (`worker.ts`); this module owns
 * only DOM wiring and rendering.
 */

import { DEMO_SCHEMA_DDL } from "../../src/demo.js";
import type { PreviewDialect } from "../../src/preview.js";
import type {
  PreviewTableView,
  WorkerRequest,
  WorkerResponse,
} from "./worker.js";

// Vite resolves this to the bundled worker URL at build time.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const ddlInput = $<HTMLTextAreaElement>("ddl");
const dialectSelect = $<HTMLSelectElement>("dialect");
const rowsInput = $<HTMLInputElement>("rows");
const seedInput = $<HTMLInputElement>("seed");
const generateBtn = $<HTMLButtonElement>("generate");
const output = $<HTMLDivElement>("output");
const notice = $<HTMLDivElement>("notice");

// Prefill with the bundled demo schema (SQLite grammar) so the page is useful
// on first paint — one click shows coherent rows.
ddlInput.value = DEMO_SCHEMA_DDL.trim();
dialectSelect.value = "sqlite";

function setBusy(busy: boolean): void {
  generateBtn.disabled = busy;
  generateBtn.textContent = busy ? "Generating…" : "Generate";
}

function showNotice(message: string, kind: "info" | "error"): void {
  notice.textContent = message;
  notice.className = `notice notice--${kind}`;
  notice.hidden = !message;
}

function renderTables(tables: PreviewTableView[]): void {
  output.replaceChildren();
  for (const t of tables) {
    const section = document.createElement("section");
    section.className = "table-card";

    const h = document.createElement("h2");
    h.textContent = t.name;
    const count = document.createElement("span");
    count.className = "row-count";
    count.textContent = `${t.rows.length} row${t.rows.length === 1 ? "" : "s"}`;
    h.appendChild(count);
    section.appendChild(h);

    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const c of t.columns) {
      const th = document.createElement("th");
      th.textContent = c.name;
      if (c.isForeignKey) {
        th.classList.add("fk");
        th.title = `foreign key → ${c.references}`;
        const mark = document.createElement("span");
        mark.className = "fk-mark";
        mark.textContent = "fk";
        th.appendChild(mark);
      }
      const type = document.createElement("span");
      type.className = "col-type";
      type.textContent = c.type;
      th.appendChild(type);
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of t.rows) {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        td.textContent = cell;
        if (cell === "NULL") td.classList.add("null");
        if (t.columns[i]?.isForeignKey) td.classList.add("fk");
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    output.appendChild(section);
  }
}

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  setBusy(false);
  const res = e.data;
  if (!res.ok) {
    output.replaceChildren();
    showNotice(res.error, "error");
    return;
  }
  renderTables(res.tables);
  showNotice(
    res.clamped
      ? "Row counts were capped so the preview stays fast in the browser. Install seedcoherent for full-size runs."
      : "",
    "info",
  );
};

worker.onerror = (e) => {
  setBusy(false);
  showNotice(`Worker error: ${e.message}`, "error");
};

function run(): void {
  setBusy(true);
  showNotice("", "info");
  const seedRaw = seedInput.value.trim();
  const seed = seedRaw === "" ? undefined : Number(seedRaw);
  const rowsRaw = Number(rowsInput.value);
  const req: WorkerRequest = {
    ddl: ddlInput.value,
    options: {
      dialect: dialectSelect.value as PreviewDialect,
      defaultRows: Number.isFinite(rowsRaw) && rowsRaw > 0 ? rowsRaw : 10,
      seed: seed !== undefined && Number.isFinite(seed) ? seed : undefined,
    },
  };
  worker.postMessage(req);
}

generateBtn.addEventListener("click", run);
