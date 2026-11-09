/**
 * Type-matrix fixtures for the round-trip harness.
 *
 * Each {@link TypeCase} is one column in a single wide table `rt`. A case
 * declares the column DDL per engine (only for the engines it applies to), an
 * optional type preamble (e.g. a Postgres `CREATE TYPE … AS ENUM`), and a
 * `check` that asserts what must hold of the values read back from the database.
 *
 * The cases are grouped by the failure areas the 0.32–0.35 correctness-hardening
 * releases fixed — narrow-integer overflow, `NUMERIC(p,s)` overflow, temporal
 * timezone/precision drift, enum label case, and array element serialization —
 * so a regression in any of them trips a case here instead of reaching a user.
 */

import assert from "node:assert/strict";

export type Engine = "postgres" | "mysql" | "sqlite" | "sqlserver";

export interface TypeCase {
  /** Column name in the `rt` table (also the SELECT target on read-back). */
  name: string;
  /** Column type + inline constraints, per engine. A missing engine is skipped. */
  ddl: Partial<Record<Engine, string>>;
  /** Optional preamble DDL (e.g. `CREATE TYPE`) run before the table, per engine. */
  preamble?: Partial<Record<Engine, string>>;
  /**
   * Validity assertion over the column's stored values (one entry per row,
   * read back `ORDER BY id`). Runs against both the live-insert and the
   * SQL-script load paths. Representation varies by engine (a `NUMERIC` may read
   * back as a string, a `DATE` as a `Date` or a string), so coerce defensively.
   */
  check: (values: unknown[], engine: Engine) => void;
}

const num = (v: unknown): number => Number(v);

/** Every case applies to at least one engine via its `ddl` keys. */
export const CASES: TypeCase[] = [
  // ── Integer widths ──────────────────────────────────────────────────────
  // Regression for the 0.35.0 narrow-int fix (`integerRange` in src/infer.ts):
  // a TINYINT/SMALLINT/YEAR drew values past its native ceiling.
  {
    name: "small_int",
    ddl: {
      postgres: "smallint NOT NULL",
      mysql: "SMALLINT NOT NULL",
      sqlite: "SMALLINT NOT NULL",
      sqlserver: "SMALLINT NOT NULL",
    },
    check: (vals, engine) => {
      for (const v of vals) {
        const n = num(v);
        assert.ok(Number.isInteger(n), `small_int not an integer: ${v}`);
        // SQLite has no integer width — affinity only — so only assert range
        // on the strongly-typed engines where the ceiling is real.
        if (engine !== "sqlite") {
          assert.ok(
            n >= -32768 && n <= 32767,
            `small_int ${n} outside SMALLINT range`,
          );
        }
      }
    },
  },
  {
    name: "tiny_int",
    ddl: { mysql: "TINYINT NOT NULL", sqlserver: "TINYINT NOT NULL" },
    check: (vals, engine) => {
      // MySQL TINYINT is signed (-128..127); SQL Server TINYINT is 0..255.
      const [lo, hi] = engine === "sqlserver" ? [0, 255] : [-128, 127];
      for (const v of vals) {
        const n = num(v);
        assert.ok(Number.isInteger(n), `tiny_int not an integer: ${v}`);
        assert.ok(n >= lo && n <= hi, `tiny_int ${n} outside [${lo},${hi}]`);
      }
    },
  },
  {
    name: "my_year",
    ddl: { mysql: "YEAR NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        const n = num(v);
        assert.ok(n >= 1901 && n <= 2155, `YEAR ${n} outside 1901..2155`);
      }
    },
  },

  // ── Numeric precision / scale ───────────────────────────────────────────
  // Regression for the `numericMagnitudeLimit` fix: a plain NUMERIC(p,s) with no
  // CHECK overflowed its precision.
  {
    name: "price",
    ddl: {
      postgres: "NUMERIC(6,2) NOT NULL",
      mysql: "DECIMAL(6,2) NOT NULL",
      sqlite: "DECIMAL(6,2) NOT NULL",
      sqlserver: "DECIMAL(6,2) NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) {
        const n = num(v);
        assert.ok(
          Math.abs(n) < 10000,
          `price ${n} overflows NUMERIC(6,2) magnitude`,
        );
      }
    },
  },
  {
    name: "amount",
    ddl: {
      postgres: "NUMERIC(5,2) NOT NULL",
      mysql: "DECIMAL(5,2) NOT NULL",
      sqlite: "DECIMAL(5,2) NOT NULL",
      sqlserver: "DECIMAL(5,2) NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) {
        const n = num(v);
        assert.ok(
          Math.abs(n) < 1000,
          `amount ${n} overflows NUMERIC(5,2) magnitude`,
        );
      }
    },
  },

  // ── Enum label case (CHECK IN) ──────────────────────────────────────────
  // Regression for the MySQL offline enum-case fix + the SQL Server IN→OR-chain
  // fix: a mixed-case membership set must round-trip exactly.
  {
    name: "status",
    ddl: {
      postgres: "text NOT NULL CHECK (status IN ('Active','Pending','Closed'))",
      mysql:
        "VARCHAR(16) NOT NULL CHECK (status IN ('Active','Pending','Closed'))",
      sqlite: "TEXT NOT NULL CHECK (status IN ('Active','Pending','Closed'))",
      sqlserver:
        "NVARCHAR(16) NOT NULL CHECK (status IN ('Active','Pending','Closed'))",
    },
    check: (vals) => {
      const set = new Set(["Active", "Pending", "Closed"]);
      for (const v of vals) {
        assert.ok(set.has(String(v)), `status ${v} not in exact-case set`);
      }
    },
  },
  // Native Postgres enum — a distinct code path from a CHECK membership set.
  {
    name: "mood",
    ddl: { postgres: "rt_mood NOT NULL" },
    preamble: { postgres: "CREATE TYPE rt_mood AS ENUM ('Happy','Sad','Meh')" },
    check: (vals) => {
      const set = new Set(["Happy", "Sad", "Meh"]);
      for (const v of vals) {
        assert.ok(set.has(String(v)), `mood ${v} not a valid enum label`);
      }
    },
  },

  // ── varchar length cap ──────────────────────────────────────────────────
  {
    name: "code5",
    ddl: {
      postgres: "varchar(5) NOT NULL",
      mysql: "VARCHAR(5) NOT NULL",
      sqlite: "VARCHAR(5) NOT NULL",
      sqlserver: "NVARCHAR(5) NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(String(v).length <= 5, `code5 "${v}" exceeds varchar(5)`);
      }
    },
  },

  // ── Booleans ────────────────────────────────────────────────────────────
  // Mainly a parity check (tinyint(1)/BIT vs native bool); validity asserts the
  // stored value is a recognizable boolean.
  {
    name: "flag",
    ddl: {
      postgres: "boolean NOT NULL",
      mysql: "TINYINT(1) NOT NULL",
      sqlite: "BOOLEAN NOT NULL",
      sqlserver: "BIT NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) {
        const ok =
          v === true ||
          v === false ||
          v === 0 ||
          v === 1 ||
          v === "0" ||
          v === "1";
        assert.ok(ok, `flag ${v} is not a boolean value`);
      }
    },
  },

  // ── Temporal ────────────────────────────────────────────────────────────
  // Validity is loose (representation differs across drivers); the real signal
  // is the script↔live PARITY check in the runner, which is exactly what the
  // MySQL DATE/DATETIME timezone + fractional-second drift violated.
  {
    name: "created_on",
    ddl: {
      postgres: "date NOT NULL",
      mysql: "DATE NOT NULL",
      sqlite: "DATE NOT NULL",
      sqlserver: "DATE NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) assert.ok(v != null, "created_on is null");
    },
  },
  {
    name: "created_at",
    ddl: {
      postgres: "timestamptz NOT NULL",
      mysql: "DATETIME(3) NOT NULL",
      sqlite: "DATETIME NOT NULL",
      // DATETIME2(3) pins millisecond precision — the JS Date's resolution — so
      // the parameterized live path and the literal script path round the
      // fractional tail identically. Plain DATETIME2 (7 digits) let them differ
      // by 1ms. This is a column-precision choice, not a workaround for a bug:
      // the harness still asserts exact script↔live parity at that precision.
      sqlserver: "DATETIME2(3) NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) assert.ok(v != null, "created_at is null");
    },
  },

  // ── Postgres arrays + bytea ─────────────────────────────────────────────
  // Regression for the 0.32.1 + 0.35.0 array-literal fixes. Element mis-format
  // ([object Object], unescaped apostrophe, wrong Date form) surfaces as either
  // an invalid value here or a script↔live parity failure in the runner.
  {
    name: "tags",
    ddl: { postgres: "text[] NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(Array.isArray(v), "tags is not an array");
        for (const el of v as unknown[])
          assert.equal(typeof el, "string", "tag element not a string");
      }
    },
  },
  {
    name: "scores",
    ddl: { postgres: "int[] NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(Array.isArray(v), "scores is not an array");
        for (const el of v as unknown[])
          assert.ok(Number.isInteger(num(el)), "score element not an integer");
      }
    },
  },
  {
    name: "seen_at",
    ddl: { postgres: "timestamptz[] NOT NULL" },
    check: (vals) => {
      for (const v of vals) assert.ok(Array.isArray(v), "seen_at not an array");
    },
  },
  {
    name: "payloads",
    ddl: { postgres: "jsonb[] NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(Array.isArray(v), "payloads not an array");
        for (const el of v as unknown[]) {
          // A mis-serialized element reads back as the string "[object Object]".
          assert.notEqual(el, "[object Object]", "jsonb[] element mangled");
          assert.equal(
            typeof el,
            "object",
            "jsonb[] element did not parse to JSON",
          );
        }
      }
    },
  },
  {
    name: "blob",
    ddl: { postgres: "bytea NOT NULL" },
    check: (vals) => {
      for (const v of vals)
        assert.ok(Buffer.isBuffer(v) || v != null, "blob is null/invalid");
    },
  },
];

/** Cases that declare a DDL fragment for the given engine. */
export function casesFor(engine: Engine): TypeCase[] {
  return CASES.filter((c) => c.ddl[engine] != null);
}

/**
 * The preamble DDL statements and `"<name> <type…>"` column clauses for an
 * engine's applicable cases. Callers prepend their own `id` primary-key column
 * and wrap the columns in a `CREATE TABLE`, so PK spelling stays engine-local.
 */
export function columnClauses(
  engine: Engine,
  cases: TypeCase[] = casesFor(engine),
): { preambles: string[]; columns: string[] } {
  const preambles: string[] = [];
  const columns: string[] = [];
  for (const c of cases) {
    const p = c.preamble?.[engine];
    if (p) preambles.push(p);
    columns.push(`${c.name} ${c.ddl[engine]}`);
  }
  return { preambles, columns };
}
