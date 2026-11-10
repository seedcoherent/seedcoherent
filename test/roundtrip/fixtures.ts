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
  /**
   * When set, the script↔live parity check compares values as timestamps with
   * this millisecond tolerance instead of byte-exactly. SQL Server's
   * parameterized (live) and literal (script) paths round the sub-millisecond
   * tail up to 1ms apart; a few-ms tolerance absorbs that while still catching
   * the drift this check exists for — timezone shifts (hours), dropped
   * fractional seconds (hundreds of ms), a DATE gaining a time component.
   */
  parityToleranceMs?: number;
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
    parityToleranceMs: 5,
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
      // the harness still asserts script↔live parity within parityToleranceMs.
      sqlserver: "DATETIME2(3) NOT NULL",
    },
    parityToleranceMs: 5,
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
  // Binary round-trips across every engine that has a native binary type. The
  // live path binds a Buffer; the script path must emit an engine-correct binary
  // literal (PG `\x…`::bytea, MySQL/SQLite `x'…'`, SQL Server `0x…`). A mis-
  // encoded literal surfaces as a rejected insert or a script↔live parity break.
  {
    // Not named `blob`: that is a reserved word in MySQL, and the harness emits
    // column names unquoted, so a reserved identifier breaks CREATE TABLE.
    name: "bin_data",
    ddl: {
      postgres: "bytea NOT NULL",
      mysql: "BLOB NOT NULL",
      sqlite: "BLOB NOT NULL",
      sqlserver: "VARBINARY(900) NOT NULL",
    },
    check: (vals) => {
      // MySQL may hand back a Buffer or a (binary) string depending on driver
      // flags; SQLite returns a Buffer; SQL Server a Buffer. Only require the
      // value be present and non-mangled — parity in the runner catches drift.
      for (const v of vals)
        assert.ok(Buffer.isBuffer(v) || v != null, "bin_data is null/invalid");
    },
  },

  // ── Cross-engine identifier (UUID/GUID) ─────────────────────────────────
  // Each engine stores a 36-char RFC-4122 identifier in its native-ish type.
  // SQL Server's UNIQUEIDENTIFIER reads back upper-cased, so lower-case first.
  {
    name: "guid",
    ddl: {
      postgres: "uuid NOT NULL",
      mysql: "CHAR(36) NOT NULL",
      sqlite: "TEXT NOT NULL",
      sqlserver: "UNIQUEIDENTIFIER NOT NULL",
    },
    check: (vals) => {
      const re =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const v of vals) {
        const s = String(v).toLowerCase();
        assert.ok(re.test(s), `guid "${v}" is not a UUID`);
      }
    },
  },

  // ── Scalar JSON ─────────────────────────────────────────────────────────
  // First harness exercise of MySQL's native JSON type and SQLite's JSON-name
  // honoring (introspect classifies any type spelled `JSON` as json, even under
  // SQLite's loose affinity). SQL Server is excluded: it has no JSON type — JSON
  // there lives in a plain nvarchar column, which carries no generation signal.
  // A mis-serialized object reads back as the literal "[object Object]".
  {
    name: "doc_json",
    ddl: {
      postgres: "jsonb NOT NULL",
      mysql: "JSON NOT NULL",
      sqlite: "JSON NOT NULL",
    },
    check: (vals) => {
      for (const v of vals) {
        assert.notEqual(v, "[object Object]", "doc_json value mangled");
        if (typeof v === "string") {
          // pg/mysql drivers auto-parse; sqlite/sqlserver hand back text.
          assert.doesNotThrow(
            () => JSON.parse(v),
            `doc_json "${v}" is not valid JSON`,
          );
        } else {
          assert.equal(typeof v, "object", "doc_json did not parse to JSON");
        }
      }
    },
  },

  // ── Native MySQL ENUM ───────────────────────────────────────────────────
  // Distinct introspection + generation path from a CHECK(IN) membership set —
  // the MySQL analogue of the Postgres-only native `mood` case above.
  {
    name: "my_enum",
    ddl: { mysql: "ENUM('Happy','Sad','Meh') NOT NULL" },
    check: (vals) => {
      const set = new Set(["Happy", "Sad", "Meh"]);
      for (const v of vals) {
        assert.ok(set.has(String(v)), `my_enum ${v} not a valid enum label`);
      }
    },
  },

  // ── MySQL MEDIUMINT width ────────────────────────────────────────────────
  // Extends the narrow-integer-overflow coverage (the 0.35.0 `integerRange`
  // fix) to MySQL's 3-byte int, whose ceiling sits between SMALLINT and INT.
  {
    name: "med_int",
    ddl: { mysql: "MEDIUMINT NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        const n = num(v);
        assert.ok(Number.isInteger(n), `med_int not an integer: ${v}`);
        assert.ok(
          n >= -8388608 && n <= 8388607,
          `med_int ${n} outside MEDIUMINT range`,
        );
      }
    },
  },

  // ── Postgres fillable literal types ──────────────────────────────────────
  // Regression for the Gap 3 coverage work: bit/varbit, geometric, and
  // tsvector/tsquery were categorized "unsupported" (NULL'd or fail-fast on
  // NOT NULL). They now generate a valid literal Postgres coerces on insert.
  {
    name: "bits",
    ddl: { postgres: "bit(8) NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        // Postgres reads a bit(n) back as a string of '0'/'1' of length n.
        assert.match(String(v), /^[01]{8}$/, `bits malformed: ${v}`);
      }
    },
  },
  {
    name: "varbits",
    ddl: { postgres: "bit varying(16) NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        const s = String(v);
        assert.match(s, /^[01]+$/, `varbits malformed: ${v}`);
        assert.ok(s.length <= 16, `varbits too long: ${v}`);
      }
    },
  },
  {
    name: "loc",
    ddl: { postgres: "point NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        // point reads back as "(x,y)".
        assert.match(
          String(v),
          /^\(-?[\d.]+,-?[\d.]+\)$/,
          `loc malformed: ${v}`,
        );
      }
    },
  },
  {
    name: "region",
    ddl: { postgres: "box NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        // box reads back as "(x1,y1),(x2,y2)".
        assert.ok(String(v).includes(","), `region malformed: ${v}`);
      }
    },
  },
  {
    name: "search_vec",
    ddl: { postgres: "tsvector NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(String(v).length > 0, "search_vec empty");
      }
    },
  },
  {
    name: "search_q",
    ddl: { postgres: "tsquery NOT NULL" },
    check: (vals) => {
      for (const v of vals) {
        assert.ok(String(v).length > 0, "search_q empty");
      }
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
