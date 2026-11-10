/**
 * Semantic inference: turn a column (name + type) into a value generator.
 * This is where output stops looking like Faker noise and starts looking real —
 * `email` yields emails, `first_name` yields first names, `price` yields money.
 */

import { Faker } from "@faker-js/faker";
import { valueSampler } from "./distribution.js";
import type { Row } from "./generate.js";
import { ctxFor, has, or, tok, type MatchCtx } from "./match.js";
import { piiGenerator } from "./pii.js";
import type {
  ColumnCheck,
  ColumnInfo,
  ColumnOverride,
  DistSpec,
  PartitionInfo,
  TableInfo,
  TypeRef,
} from "./types.js";

/**
 * Turn a Faker instance into one generated value. The optional `row` is the
 * partially-built row for the current record, populated left-to-right in column
 * order; a `template:` override reads earlier sibling columns from it. Ordinary
 * generators ignore it, so a plain `(f) => x` stays assignable here.
 */
export type Generator = (f: Faker, row?: Row) => unknown;

/** A name-based rule: if the column name matches, use this generator. */
interface NameRule {
  test: (c: MatchCtx) => boolean;
  gen: Generator;
}

/** Ordered — first match wins, so put specific rules before generic ones. */
const NAME_RULES: NameRule[] = [
  { test: has("email"), gen: (f) => f.internet.email().toLowerCase() },
  {
    test: tok("username", "login", "handle"),
    gen: (f) => f.internet.username().toLowerCase(),
  },
  { test: has("password", "passwd", "pwd"), gen: (f) => f.internet.password() },
  { test: has("firstname", "givenname"), gen: (f) => f.person.firstName() },
  {
    test: has("lastname", "surname", "familyname"),
    gen: (f) => f.person.lastName(),
  },
  { test: has("middlename"), gen: (f) => f.person.firstName() },
  { test: has("fullname", "displayname"), gen: (f) => f.person.fullName() },
  {
    test: (c) => c.n === "name" || c.n.includes("contactname"),
    gen: (f) => f.person.fullName(),
  },
  {
    test: has("company", "organization", "organisation", "employer"),
    gen: (f) => f.company.name(),
  },
  {
    test: or(has("jobtitle", "occupation"), tok("position", "role")),
    gen: (f) => f.person.jobTitle(),
  },
  {
    test: or(has("phone", "mobile"), tok("cell", "fax")),
    gen: (f) => f.phone.number(),
  },
  {
    test: or(
      has("avatar", "profilepic", "thumbnail"),
      tok("photo", "picture", "image"),
    ),
    gen: (f) => f.image.url(),
  },
  { test: has("website", "homepage"), gen: (f) => f.internet.url() },
  { test: has("useragent"), gen: (f) => f.internet.userAgent() },
  {
    test: or(has("ipaddress", "ipaddr"), tok("ip")),
    gen: (f) => f.internet.ipv4(),
  },
  { test: or(has("macaddress"), tok("mac")), gen: (f) => f.internet.mac() },
  { test: tok("url", "uri", "link", "href"), gen: (f) => f.internet.url() },
  { test: or(has("permalink"), tok("slug")), gen: (f) => f.lorem.slug() },
  {
    test: has("addressline", "streetaddress", "street"),
    gen: (f) => f.location.streetAddress(),
  },
  { test: tok("address"), gen: (f) => f.location.streetAddress() },
  { test: tok("city", "town"), gen: (f) => f.location.city() },
  { test: tok("state", "province", "region"), gen: (f) => f.location.state() },
  { test: tok("country"), gen: (f) => f.location.country() },
  {
    test: or(has("zipcode", "postalcode", "postcode"), tok("zip")),
    gen: (f) => f.location.zipCode(),
  },
  { test: or(has("latitude"), tok("lat")), gen: (f) => f.location.latitude() },
  {
    test: or(has("longitude"), tok("lng", "lon")),
    gen: (f) => f.location.longitude(),
  },
  { test: has("timezone"), gen: (f) => f.location.timeZone() },
  { test: tok("currency"), gen: (f) => f.finance.currencyCode() },
  { test: tok("iban"), gen: (f) => f.finance.iban() },
  {
    test: has("creditcard", "cardnumber"),
    gen: (f) => f.finance.creditCardNumber(),
  },
  {
    test: or(
      has("price", "amount", "subtotal", "salary"),
      tok("cost", "total", "balance", "fee"),
    ),
    gen: (f) => Number(f.commerce.price()),
  },
  { test: has("productname"), gen: (f) => f.commerce.productName() },
  { test: tok("product"), gen: (f) => f.commerce.product() },
  { test: has("color", "colour"), gen: (f) => f.color.human() },
  {
    test: or(has("headline"), tok("title", "subject")),
    gen: (f) => f.lorem.sentence({ min: 2, max: 6 }).replace(/\.$/, ""),
  },
  {
    test: or(
      has("description"),
      tok(
        "summary",
        "bio",
        "about",
        "body",
        "content",
        "message",
        "comment",
        "text",
        "note",
        "notes",
      ),
    ),
    gen: (f) => f.lorem.paragraph(),
  },
  {
    test: or(
      has("firstseen", "createdat", "insertedat", "registeredat"),
      tok("created"),
    ),
    gen: (f) => f.date.past({ years: 2 }),
  },
  {
    test: has("updatedat", "modifiedat", "lastseen", "lastlogin"),
    gen: (f) => f.date.recent({ days: 30 }),
  },
  {
    test: has("deletedat", "expiresat", "expiredat"),
    gen: (f) => f.date.future({ years: 1 }),
  },
  {
    test: or(has("birthdate", "dateofbirth", "birthday"), tok("dob")),
    gen: (f) => f.date.birthdate(),
  },
  { test: tok("gender", "sex"), gen: (f) => f.person.sexType() },
  { test: tok("uuid", "guid"), gen: (f) => f.string.uuid() },
];

type NumericRule = {
  test: (c: MatchCtx) => boolean;
  gen: (f: Faker, col: ColumnInfo) => number;
};

/**
 * Upper bound for an integer column whose declared width is narrower than the
 * generic default — so a `TINYINT`/`SMALLINT`/`YEAR` column never receives a
 * value the database rejects as out of range. Keyed by normalized `udtName`
 * across engines (Postgres `int2`; MySQL/SQL Server `tinyint`/`smallint`). The
 * generator's `min` is 0, so an `UNSIGNED` column (whose max is higher) stays in
 * range too. Wider types (`int4`/`int`/`mediumint`/`bigint`/`int8`) are omitted:
 * the generic default already fits them, so their output is left unchanged.
 */
const NARROW_INTEGER_MAX: Record<string, number> = {
  int2: 32767,
  smallint: 32767,
  tinyint: 127,
};
const DEFAULT_INTEGER_MAX = 1_000_000;

/** Inclusive integer range a generated value must stay within for `col`'s type. */
function integerRange(col: ColumnInfo): { min: number; max: number } {
  const key = col.udtName?.toLowerCase() ?? "";
  // MySQL YEAR accepts 1901–2155 only.
  if (key === "year") return { min: 1901, max: 2155 };
  return { min: 0, max: NARROW_INTEGER_MAX[key] ?? DEFAULT_INTEGER_MAX };
}

/**
 * Largest magnitude a `numeric(p, s)` column can hold — `10^(p-s)` minus one
 * scale unit — or `null` when no precision is declared. Used to keep generated
 * decimals from overflowing the column even when no CHECK bound was parsed.
 */
function numericMagnitudeLimit(
  col: ColumnInfo,
  scale: number,
  eps: number,
): number | null {
  if (col.numericPrecision != null && col.numericPrecision > 0) {
    return Math.pow(10, col.numericPrecision - scale) - eps;
  }
  return null;
}

/**
 * Name rules for numeric columns. `NAME_RULES` only apply to text/date columns,
 * so without these an `integer`/`numeric` column named `age` or `rating` would
 * fall through to a generic 0..1,000,000 range. First match wins.
 */
const NUMERIC_NAME_RULES: NumericRule[] = [
  { test: tok("age"), gen: (f) => f.number.int({ min: 0, max: 95 }) },
  { test: tok("year"), gen: (f) => f.number.int({ min: 1970, max: 2025 }) },
  {
    test: or(has("quantity"), tok("qty")),
    gen: (f) => f.number.int({ min: 1, max: 100 }),
  },
  {
    test: tok("rating", "stars"),
    gen: (f) => f.number.int({ min: 1, max: 5 }),
  },
  {
    test: tok("score", "points"),
    gen: (f) => f.number.int({ min: 0, max: 100 }),
  },
  {
    test: or(has("percentage"), tok("percent", "discount")),
    gen: (f) => f.number.int({ min: 0, max: 100 }),
  },
  { test: tok("count"), gen: (f) => f.number.int({ min: 0, max: 1000 }) },
  {
    test: or(
      has("price", "amount", "subtotal", "salary"),
      tok("cost", "total", "balance", "fee"),
    ),
    gen: (f, col) => {
      const scale = Math.min(col.numericScale ?? 2, 6);
      const eps = Math.pow(10, -scale);
      const limit = numericMagnitudeLimit(col, scale, eps);
      let max = limit != null ? Math.min(10_000, limit) : 10_000;
      if (col.dataType === "integer")
        max = Math.min(max, integerRange(col).max);
      const val = f.number.float({ min: 0, max, fractionDigits: scale });
      return col.dataType === "integer" ? Math.round(val) : val;
    },
  },
];

/** Type-category fallback when no name rule matches. */
function generatorForType(col: ColumnInfo): Generator {
  const max = col.maxLength ?? undefined;
  switch (col.dataType) {
    case "enum":
      return (f) => f.helpers.arrayElement(col.enumValues!);
    case "boolean":
      return (f) => f.datatype.boolean();
    case "uuid":
      return (f) => f.string.uuid();
    case "integer": {
      const { min, max } = integerRange(col);
      return (f) => f.number.int({ min, max });
    }
    case "decimal": {
      const scale = Math.min(col.numericScale ?? 2, 6);
      const eps = Math.pow(10, -scale);
      const limit = numericMagnitudeLimit(col, scale, eps);
      const max = limit != null ? Math.min(100000, limit) : 100000;
      return (f) => f.number.float({ min: 0, max, fractionDigits: scale });
    }
    case "date":
      return (f) => f.date.past({ years: 3 });
    case "time":
      return (f) => `${f.date.anytime().toTimeString().slice(0, 8)}`;
    case "timestamp":
      return (f) => f.date.past({ years: 2 });
    case "json":
      return jsonGenerator(col);
    case "bytea":
      return (f) => Buffer.from(f.string.alphanumeric(16));
    case "inet":
      return (f) => f.internet.ipv4();
    case "money":
      // A plain numeric string; Postgres coerces it to `money` on insert.
      return (f) => f.finance.amount({ min: 0, max: 100_000, dec: 2 });
    case "interval":
      return (f) => intervalLiteral(f);
    case "macaddr":
      // Six colon-separated octets; Postgres widens this to macaddr8 as needed.
      return (f) => f.internet.mac();
    case "xml":
      return (f) =>
        `<record><id>${f.string.uuid()}</id><value>${f.lorem.word()}</value></record>`;
    case "array": {
      const elemGen = col.elementType
        ? typeRefGenerator(col.elementType)
        : (f: Faker) => f.lorem.word();
      return (f) =>
        f.helpers.multiple(() => elemGen(f), { count: { min: 0, max: 3 } });
    }
    case "composite":
      return compositeGenerator(col.compositeFields ?? []);
    case "range":
      return rangeGenerator(col.rangeSubtype);
    case "bitstring": {
      // bit(n) has a fixed length (col.maxLength); bit varying may be
      // unbounded, so cap at a small random width. Postgres coerces the
      // '0'/'1' string literal to bit/varbit.
      return (f) => {
        const len = max ?? f.number.int({ min: 1, max: 8 });
        return Array.from({ length: len }, () =>
          f.helpers.arrayElement(["0", "1"]),
        ).join("");
      };
    }
    case "geometric":
      return geometricGenerator(col.udtName);
    case "tsvector":
      // A space-separated set of lexemes; Postgres parses the literal to
      // tsvector (whitespace becomes the token separator).
      return (f) => f.lorem.words({ min: 2, max: 5 });
    case "tsquery":
      // Lexemes joined with tsquery operators (& / |); a valid query string.
      return (f) =>
        f.helpers
          .multiple(() => f.lorem.word(), { count: { min: 1, max: 3 } })
          .join(f.helpers.arrayElement([" & ", " | "]));
    case "unsupported":
      // No safe literal for this type. Emit NULL — valid for nullable columns;
      // NOT NULL ones without a default/override are rejected up front by
      // requiredUnsupportedColumns before any rows are written.
      return () => null;
    case "text":
    default:
      return (f) => {
        const word = f.lorem.words({ min: 1, max: 3 });
        return max && word.length > max ? word.slice(0, max) : word;
      };
  }
}

/**
 * Name-driven JSON/JSONB shapes. A live database only tells us a column is
 * `json`; its *name* is the only hint about what it holds, exactly as with
 * scalar columns. So `address` gets a structured address, `tags` a string
 * array, `settings` a small preferences object — instead of the same opaque
 * stub for every JSON column. First match wins; anything unrecognized falls
 * through to a generic attribute bag. The result is a plain JS value the
 * emitters already `JSON.stringify`, so it flows through unchanged.
 */
const JSON_RULES: NameRule[] = [
  {
    test: or(has("shippingaddress", "billingaddress"), tok("address")),
    gen: (f) => ({
      street: f.location.streetAddress(),
      city: f.location.city(),
      state: f.location.state({ abbreviated: true }),
      zip: f.location.zipCode(),
      country: f.location.country(),
    }),
  },
  {
    test: or(has("latlng"), tok("coordinates", "coords", "geo", "location")),
    gen: (f) => ({ lat: f.location.latitude(), lng: f.location.longitude() }),
  },
  {
    test: tok("tags", "labels", "keywords", "categories"),
    gen: (f) =>
      f.helpers.multiple(() => f.lorem.word(), { count: { min: 1, max: 4 } }),
  },
  {
    test: tok("permissions", "scopes", "roles"),
    gen: (f) =>
      f.helpers.arrayElements(
        ["read", "write", "create", "update", "delete", "admin"],
        { min: 1, max: 4 },
      ),
  },
  {
    test: tok(
      "settings",
      "preferences",
      "prefs",
      "config",
      "configuration",
      "options",
    ),
    gen: (f) => ({
      theme: f.helpers.arrayElement(["light", "dark", "system"]),
      language: f.helpers.arrayElement(["en", "es", "fr", "de", "ja"]),
      notifications: f.datatype.boolean(),
    }),
  },
  {
    test: or(has("dimensions"), tok("size")),
    gen: (f) => ({
      width: f.number.int({ min: 1, max: 200 }),
      height: f.number.int({ min: 1, max: 200 }),
      unit: "cm",
    }),
  },
  {
    test: tok("contact"),
    gen: (f) => ({
      email: f.internet.email().toLowerCase(),
      phone: f.phone.number(),
    }),
  },
  {
    test: or(has("pricing"), tok("price", "money", "cost")),
    gen: (f) => ({
      amount: Number(f.commerce.price()),
      currency: f.finance.currencyCode(),
    }),
  },
  {
    test: tok("profile"),
    gen: (f) => ({
      bio: f.lorem.sentence(),
      avatar: f.image.avatar(),
      website: f.internet.url(),
    }),
  },
];

/**
 * Pick a JSON generator from the column name, or fall back to a generic bag of
 * plausible attributes (kept small and stable so unmatched columns still emit a
 * valid, varied object).
 */
function jsonGenerator(col: ColumnInfo): Generator {
  const ctx: MatchCtx = ctxFor(col.name);
  for (const rule of JSON_RULES) {
    if (rule.test(ctx)) return rule.gen;
  }
  return (f) => ({
    id: f.string.uuid(),
    source: f.helpers.arrayElement(["web", "mobile", "api", "import"]),
    version: f.number.int({ min: 1, max: 5 }),
  });
}

/**
 * A Postgres `interval` literal like `"3 days 04:05:06"` — a random day span plus
 * a time-of-day component. Postgres parses this textual form directly.
 */
function intervalLiteral(f: Faker): string {
  const days = f.number.int({ min: 0, max: 90 });
  const h = String(f.number.int({ min: 0, max: 23 })).padStart(2, "0");
  const m = String(f.number.int({ min: 0, max: 59 })).padStart(2, "0");
  const s = String(f.number.int({ min: 0, max: 59 })).padStart(2, "0");
  return `${days} days ${h}:${m}:${s}`;
}

/**
 * Built-in geometric types: emit the Postgres text representation as a string
 * literal, which Postgres coerces to the column type on insert. One shape per
 * udtName — point `(x,y)`, lseg/box as two points, line `{A,B,C}`, path/polygon
 * as a point list, circle `<(x,y),r>`.
 */
function geometricGenerator(udtName: string): Generator {
  const coord = (f: Faker) =>
    f.number.float({ min: -1000, max: 1000, fractionDigits: 2 });
  const pt = (f: Faker) => `(${coord(f)},${coord(f)})`;
  const points = (f: Faker, n: number) =>
    Array.from({ length: n }, () => pt(f)).join(",");
  switch (udtName) {
    case "point":
      return (f) => pt(f);
    case "lseg":
    case "box":
      return (f) => `(${pt(f)},${pt(f)})`;
    case "line":
      // Standard-form coefficients {A,B,C}; A and B must not both be zero.
      return (f) =>
        `{${f.number.float({ min: -10, max: 10, fractionDigits: 2 }) || 1},${coord(f)},${coord(f)}}`;
    case "path":
    case "polygon":
      return (f) => `(${points(f, f.number.int({ min: 3, max: 5 }))})`;
    case "circle":
      return (f) =>
        `<${pt(f)},${f.number.float({ min: 0.1, max: 500, fractionDigits: 2 })}>`;
    default:
      return () => null;
  }
}

/** Minimal ColumnInfo so a nested type (array element, composite field) can reuse generatorForType. */
function refToColumn(ref: TypeRef): ColumnInfo {
  return {
    name: "",
    udtName: ref.udtName,
    dataType: ref.dataType,
    enumValues: ref.enumValues,
    nullable: false,
    hasDefault: false,
    defaultExpr: null,
    isIdentity: false,
    isGenerated: false,
    maxLength: null,
    numericPrecision: null,
    numericScale: null,
  };
}

/** A value generator for a resolved element/field type (arrays, composite fields). */
function typeRefGenerator(ref: TypeRef): Generator {
  return generatorForType(refToColumn(ref));
}

/**
 * Composite (row) type: emit a Postgres record literal like `("a b",1,"x")`.
 * Producing a valid literal string lets it flow through the ordinary string
 * path in both the SQL and COPY emitters — Postgres coerces it to the row type.
 */
function compositeGenerator(fields: TypeRef[]): Generator {
  const gens = fields.map((fld) => typeRefGenerator(fld));
  return (f) => `(${gens.map((g) => recordField(g(f))).join(",")})`;
}

/** Format one composite field for a record literal (NULL is an empty, unquoted field). */
function recordField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  const s =
    v instanceof Date
      ? v.toISOString()
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  // Quote every scalar so commas/spaces/empties survive; escape " and \ with a backslash.
  return `"${s.replace(/([\\"])/g, "\\$1")}"`;
}

/** Range type: emit a `[lower,upper)` literal with a coherent lower < upper. */
function rangeGenerator(sub: TypeRef | undefined): Generator {
  const cat = sub?.dataType;
  return (f) => {
    if (cat === "integer") {
      const a = f.number.int({ min: 0, max: 100_000 });
      return `[${a},${a + f.number.int({ min: 1, max: 1000 })})`;
    }
    if (cat === "decimal") {
      const a = f.number.float({ min: 0, max: 100_000, fractionDigits: 2 });
      return `[${a},${(a + f.number.float({ min: 1, max: 1000, fractionDigits: 2 })).toFixed(2)})`;
    }
    const a = f.date.past({ years: 2 });
    const b = new Date(
      a.getTime() + f.number.int({ min: 1, max: 365 }) * 86_400_000,
    );
    if (cat === "date")
      return `[${a.toISOString().slice(0, 10)},${b.toISOString().slice(0, 10)})`;
    return `["${a.toISOString()}","${b.toISOString()}")`;
  };
}

/** Resolve a faker path like "internet.email" against a Faker instance. */
function resolveFakerPath(path: string): Generator {
  const parts = path.split(".");
  return (f) => {
    let node: any = f;
    for (const p of parts) node = node?.[p];
    if (typeof node !== "function") {
      throw new Error(`Invalid faker path "${path}" (not a function)`);
    }
    // Rebind to its parent module so faker's internal `this` is correct.
    const parent = parts.slice(0, -1).reduce<any>((acc, p) => acc?.[p], f);
    return node.call(parent);
  };
}

function overrideToGenerator(o: ColumnOverride): Generator {
  if (typeof o === "string") return resolveFakerPath(o);
  if ("faker" in o) return resolveFakerPath(o.faker);
  if ("values" in o) return (f) => f.helpers.arrayElement(o.values);
  if ("pattern" in o) {
    const gen = patternGenerator(o.pattern);
    if (!gen)
      throw new Error(
        `Unsupported pattern override "${o.pattern}". Supported: literals, ` +
          `character classes ([A-Z], \\d, \\w, .), quantifiers (* + ? {n} {n,m}), ` +
          `groups and alternation (a|b); leading ^ / trailing $ are optional.`,
      );
    return gen;
  }
  if ("template" in o) return templateGenerator(o.template);
  return () => o.value;
}

/**
 * Pick the generator for a column, honoring user overrides first, then name
 * heuristics, then type. Overrides are keyed by "table.column" or bare "column".
 * A `check` (distilled from CHECK constraints) is applied last so generated
 * values stay inside what the database will accept.
 */
export function inferGenerator(
  table: TableInfo,
  col: ColumnInfo,
  overrides: Record<string, ColumnOverride> = {},
  check?: ColumnCheck,
  dist?: DistSpec,
): Generator {
  const qualified =
    overrides[`${table.name}.${col.name}`] ??
    overrides[`${table.key}.${col.name}`];
  const bare = overrides[col.name];
  const override = qualified ?? bare;

  // A configured value distribution reshapes how a categorical column spreads
  // over its labels. It only runs when the user opted this column in; otherwise
  // the original path below is untouched, so seeded output stays byte-identical.
  if (dist !== undefined) {
    const weighted = distributedValueGenerator(col, check, override, dist);
    if (weighted) return weighted;
  }

  // An explicit override is the user's stated intent — respect it verbatim.
  if (override) return overrideToGenerator(override);

  const base = baseGenerator(table, col);
  return check ? applyCheck(base, col, check) : base;
}

/**
 * Build a distribution-shaped generator for a categorical column, or `null` when
 * there is no label set to weight (so the caller keeps the ordinary generator).
 * The value set is taken, in precedence order, from: a `weighted:` spec's own
 * values; a `values:` override; an enum column's labels; a `CHECK col IN (...)`
 * membership set. Uniform specs yield `null` too — the even-spread generator is
 * already what an unshaped column uses.
 */
function distributedValueGenerator(
  col: ColumnInfo,
  check: ColumnCheck | undefined,
  override: ColumnOverride | undefined,
  dist: DistSpec,
): Generator | null {
  const weighted = typeof dist === "object" && dist.kind === "weighted";
  let values: unknown[] | null = null;
  if (weighted) {
    values = []; // valueSampler supplies its own values for the weighted spec
  } else if (override && typeof override === "object" && "values" in override) {
    values = override.values;
  } else if (col.dataType === "enum" && col.enumValues) {
    values = col.enumValues;
  } else if (check?.in && check.in.length > 0) {
    values = check.in;
  }
  if (values === null) return null;
  const sampler = valueSampler(values, dist);
  return sampler ? (f) => sampler(f) : null;
}

/** Name/type generator selection, before any CHECK constraint is applied. */
function baseGenerator(table: TableInfo, col: ColumnInfo): Generator {
  // Enum columns must draw from their allowed labels regardless of the name.
  if (col.dataType === "enum") return generatorForType(col);

  const ctx: MatchCtx = ctxFor(col.name);
  // Numeric columns get their own name rules; text/date name rules can't apply.
  if (col.dataType === "integer" || col.dataType === "decimal") {
    for (const rule of NUMERIC_NAME_RULES) {
      if (rule.test(ctx)) return (f) => rule.gen(f, col);
    }
  }
  // High-risk PII categories (SSN, tax id, passport, …) that the name rules
  // below don't cover get a dedicated, realistic generator — but only when the
  // column type can hold it, same gate as the name rules.
  const pii = piiGenerator(col);
  if (pii && isCompatible(col)) return pii;
  for (const rule of NAME_RULES) {
    if (rule.test(ctx)) {
      // Only accept a name-based text/date rule if the column type is compatible;
      // e.g. don't stuff a paragraph into an integer column named "comment_count".
      if (isCompatible(col)) return rule.gen;
    }
  }
  return generatorForType(col);
}

/** Number of retries when sampling a string against a compiled regex. */
const PATTERN_RETRIES = 40;

/** Compile a CHECK regex, or null if the engine can't parse it. */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Does `v` satisfy every *other* recognized bound in `check`? Used to filter a
 * membership (`IN`) set so a co-present range/length/pattern isn't ignored — the
 * value still comes from the enumerated set, but only its in-bounds members.
 */
function allowedByCheck(v: string | number, check: ColumnCheck): boolean {
  if (typeof v === "number") {
    if (check.min !== undefined) {
      if (check.minExclusive ? v <= check.min : v < check.min) return false;
    }
    if (check.max !== undefined) {
      if (check.maxExclusive ? v >= check.max : v > check.max) return false;
    }
  } else {
    if (check.minLength !== undefined && v.length < check.minLength)
      return false;
    if (check.maxLength !== undefined && v.length > check.maxLength)
      return false;
    if (check.pattern) {
      const re = compilePattern(check.pattern);
      if (re && !re.test(v)) return false;
    }
  }
  return true;
}

/** Wrap a base generator so its output satisfies a column's CHECK bounds. */
function applyCheck(
  base: Generator,
  col: ColumnInfo,
  check: ColumnCheck,
): Generator {
  // A membership set enumerates the candidate values, but a co-present range,
  // length, or pattern narrows it further — draw only from the members that also
  // satisfy those. (An empty intersection is an impossible CHECK; keep the
  // original set so we stay in membership rather than emit anything — a later
  // hardening phase surfaces it up-front.)
  if (check.in && check.in.length > 0) {
    const narrowed = check.in.filter((v) => allowedByCheck(v, check));
    const values = narrowed.length > 0 ? narrowed : check.in;
    return (f) => f.helpers.arrayElement(values);
  }

  // A regex dictates the string format (zip codes, product SKUs, ...).
  if (check.pattern) {
    const gen = patternGenerator(check.pattern);
    if (gen) return gen;
    // Recognized but not samplable by the mini-engine: retry the base generator
    // against the real regex instead of falling through to unconstrained text.
    const re = compilePattern(check.pattern);
    if (re) {
      return (f) => {
        for (let i = 0; i < PATTERN_RETRIES; i++) {
          const s = String(base(f));
          if (re.test(s)) return constrainLength(s, col, check, f);
        }
        return constrainLength(String(base(f)), col, check, f);
      };
    }
  }

  const isNumeric = col.dataType === "integer" || col.dataType === "decimal";
  if (isNumeric && (check.min !== undefined || check.max !== undefined)) {
    return boundedNumber(col, check);
  }

  if (
    col.dataType === "text" &&
    (check.minLength !== undefined || check.maxLength !== undefined)
  ) {
    return (f) => constrainLength(String(base(f)), col, check, f);
  }

  return base;
}

/** Build a number generator confined to a CHECK's inclusive/exclusive bounds. */
function boundedNumber(col: ColumnInfo, check: ColumnCheck): Generator {
  const SPAN = 1000;
  if (col.dataType === "integer") {
    let lo =
      check.min !== undefined
        ? Math.ceil(check.min) + (check.minExclusive ? 1 : 0)
        : undefined;
    let hi =
      check.max !== undefined
        ? Math.floor(check.max) - (check.maxExclusive ? 1 : 0)
        : undefined;
    if (lo === undefined) lo = hi! - SPAN;
    if (hi === undefined) hi = lo + SPAN;
    // Keep an open-ended SPAN (and the CHECK bound itself) inside the column's
    // integer width, so e.g. a SMALLINT never overflows its 32767 ceiling.
    const width = integerRange(col);
    lo = Math.max(lo, width.min);
    hi = Math.min(hi, width.max);
    if (lo > hi) hi = lo;
    const [min, max] = [lo, hi];
    return (f) => f.number.int({ min, max });
  }
  const scale = Math.min(col.numericScale ?? 2, 6);
  const eps = Math.pow(10, -scale);
  let lo =
    check.min !== undefined
      ? check.min + (check.minExclusive ? eps : 0)
      : undefined;
  let hi =
    check.max !== undefined
      ? check.max - (check.maxExclusive ? eps : 0)
      : undefined;
  if (lo === undefined) lo = Math.min(0, hi!);
  if (hi === undefined) hi = lo + SPAN;
  if (lo > hi) hi = lo;
  // An open-ended SPAN must not overflow numeric(p, s): the largest magnitude a
  // numeric(p, s) holds is 10^(p-s) minus one scale unit.
  const limit = numericMagnitudeLimit(col, scale, eps);
  if (limit != null) {
    hi = Math.min(hi, limit);
    lo = Math.max(lo, -limit);
    if (lo > hi) hi = lo;
  }
  const [min, max] = [lo, hi];
  return (f) => f.number.float({ min, max, fractionDigits: scale });
}

// ---- minimal regex sampler ----
// Enough to satisfy the anchored patterns real domain/CHECK constraints use
// (digit runs, character classes, quantifiers, simple alternation). Anything it
// can't parse yields null, and the caller keeps the unconstrained generator.

type ReNode =
  | { t: "seq"; items: ReNode[] }
  | { t: "alt"; opts: ReNode[] }
  | { t: "rep"; node: ReNode; min: number; max: number }
  | { t: "class"; chars: string[] }
  | { t: "lit"; s: string };

const MAX_REP = 4;

/** Build a generator producing strings that match `pattern`, or null if unsupported. */
function patternGenerator(pattern: string): Generator | null {
  let src = pattern;
  if (src.startsWith("^")) src = src.slice(1);
  if (/[^\\]\$$|^\$$/.test(src)) src = src.slice(0, -1); // trailing, unescaped `$`
  try {
    const c = { s: src, i: 0 };
    const node = parseAlt(c);
    if (c.i !== src.length) return null; // trailing unparsed input
    return (f) => emitNode(node, f);
  } catch {
    return null;
  }
}

function parseAlt(c: { s: string; i: number }): ReNode {
  const opts = [parseSeq(c)];
  while (c.s[c.i] === "|") {
    c.i++;
    opts.push(parseSeq(c));
  }
  return opts.length === 1 ? opts[0] : { t: "alt", opts };
}

function parseSeq(c: { s: string; i: number }): ReNode {
  const items: ReNode[] = [];
  while (c.i < c.s.length && c.s[c.i] !== "|" && c.s[c.i] !== ")") {
    items.push(parseRep(c));
  }
  return { t: "seq", items };
}

function parseRep(c: { s: string; i: number }): ReNode {
  const atom = parseAtom(c);
  const ch = c.s[c.i];
  if (ch === "*")
    return (c.i++, { t: "rep", node: atom, min: 0, max: MAX_REP });
  if (ch === "+")
    return (c.i++, { t: "rep", node: atom, min: 1, max: MAX_REP });
  if (ch === "?") return (c.i++, { t: "rep", node: atom, min: 0, max: 1 });
  if (ch === "{") {
    const close = c.s.indexOf("}", c.i);
    if (close === -1) throw new Error("unterminated {");
    const body = c.s.slice(c.i + 1, close);
    const m = body.match(/^(\d+)(,(\d*)?)?$/);
    if (!m) throw new Error("bad quantifier");
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : min + MAX_REP;
    c.i = close + 1;
    return { t: "rep", node: atom, min, max };
  }
  return atom;
}

function parseAtom(c: { s: string; i: number }): ReNode {
  const ch = c.s[c.i];
  if (ch === "(") {
    c.i++;
    // Skip a non-capturing group marker `?:`.
    if (c.s.startsWith("?:", c.i)) c.i += 2;
    const inner = parseAlt(c);
    if (c.s[c.i] !== ")") throw new Error("unbalanced (");
    c.i++;
    return inner;
  }
  if (ch === "[") return parseClass(c);
  if (ch === "\\") return parseEscape(c);
  if (ch === ".") return (c.i++, { t: "class", chars: expandRange("a", "z") });
  if (ch === undefined || "*+?{}|)".includes(ch))
    throw new Error("unexpected token");
  c.i++;
  return { t: "lit", s: ch };
}

function parseClass(c: { s: string; i: number }): ReNode {
  c.i++; // consume [
  let negate = false;
  if (c.s[c.i] === "^") {
    negate = true;
    c.i++;
  }
  const chars: string[] = [];
  while (c.i < c.s.length && c.s[c.i] !== "]") {
    let lo: string;
    if (c.s[c.i] === "\\") {
      const esc = classEscape(c.s[c.i + 1]);
      c.i += 2;
      if (esc) {
        chars.push(...esc);
        continue;
      }
      lo = c.s[c.i - 1];
    } else {
      lo = c.s[c.i++];
    }
    if (c.s[c.i] === "-" && c.s[c.i + 1] !== "]" && c.i + 1 < c.s.length) {
      const hi = c.s[c.i + 1];
      c.i += 2;
      chars.push(...expandRange(lo, hi));
    } else {
      chars.push(lo);
    }
  }
  if (c.s[c.i] !== "]") throw new Error("unterminated class");
  c.i++;
  if (negate) {
    const base = new Set([
      ...expandRange("a", "z"),
      ...expandRange("A", "Z"),
      ...expandRange("0", "9"),
    ]);
    for (const ch of chars) base.delete(ch);
    return { t: "class", chars: [...base] };
  }
  return { t: "class", chars };
}

function parseEscape(c: { s: string; i: number }): ReNode {
  const next = c.s[c.i + 1];
  c.i += 2;
  const cls = classEscape(next);
  if (cls) return { t: "class", chars: cls };
  if (next === undefined) throw new Error("trailing backslash");
  return { t: "lit", s: next };
}

/** Character set for a class shorthand (`\d`, `\w`, `\s`), or null for a literal escape. */
function classEscape(ch: string | undefined): string[] | null {
  if (ch === "d") return expandRange("0", "9");
  if (ch === "w")
    return [
      ...expandRange("a", "z"),
      ...expandRange("A", "Z"),
      ...expandRange("0", "9"),
      "_",
    ];
  if (ch === "s") return [" "];
  return null;
}

function expandRange(lo: string, hi: string): string[] {
  const out: string[] = [];
  for (let cc = lo.charCodeAt(0); cc <= hi.charCodeAt(0); cc++)
    out.push(String.fromCharCode(cc));
  return out;
}

function emitNode(node: ReNode, f: Faker): string {
  switch (node.t) {
    case "seq":
      return node.items.map((n) => emitNode(n, f)).join("");
    case "alt":
      return emitNode(f.helpers.arrayElement(node.opts), f);
    case "rep": {
      const n = f.number.int({
        min: node.min,
        max: Math.max(node.min, node.max),
      });
      let s = "";
      for (let k = 0; k < n; k++) s += emitNode(node.node, f);
      return s;
    }
    case "class":
      return node.chars.length ? f.helpers.arrayElement(node.chars) : "";
    case "lit":
      return node.s;
  }
}

// ---- template strings ----
// Literal text with `{...}` placeholders. A placeholder is one of: `seq` /
// `seq:START` (a per-column counter), a dotted faker path like `internet.email`,
// or a bare identifier naming an earlier sibling column on the same row. Braces
// are escaped by doubling: `{{` and `}}`.

type TemplatePart =
  | { t: "lit"; s: string }
  | { t: "seq"; start: number }
  | { t: "faker"; gen: Generator }
  | { t: "col"; name: string };

function parseTemplate(tpl: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let lit = "";
  const pushLit = () => {
    if (lit) parts.push({ t: "lit", s: lit });
    lit = "";
  };
  for (let i = 0; i < tpl.length; i++) {
    const ch = tpl[i];
    if (ch === "{" && tpl[i + 1] === "{") {
      lit += "{";
      i++;
      continue;
    }
    if (ch === "}" && tpl[i + 1] === "}") {
      lit += "}";
      i++;
      continue;
    }
    if (ch === "}") throw new Error(`Unmatched "}" in template "${tpl}"`);
    if (ch !== "{") {
      lit += ch;
      continue;
    }
    const close = tpl.indexOf("}", i + 1);
    if (close === -1) throw new Error(`Unterminated "{" in template "${tpl}"`);
    const body = tpl.slice(i + 1, close).trim();
    i = close;
    if (!body) throw new Error(`Empty placeholder "{}" in template "${tpl}"`);
    pushLit();
    if (body === "seq" || body.startsWith("seq:")) {
      const start = body === "seq" ? 1 : Number(body.slice(4));
      if (!Number.isInteger(start))
        throw new Error(
          `Invalid sequence start in "{${body}}" (expected {seq} or {seq:N})`,
        );
      parts.push({ t: "seq", start });
    } else if (body.includes(".")) {
      parts.push({ t: "faker", gen: resolveFakerPath(body) });
    } else {
      parts.push({ t: "col", name: body });
    }
  }
  pushLit();
  return parts;
}

/** Build a generator that fills a `{...}` template per row. */
function templateGenerator(tpl: string): Generator {
  const parts = parseTemplate(tpl);
  const counters = new Map<number, number>(); // part index → next value
  return (f, row) =>
    parts
      .map((p, idx) => {
        switch (p.t) {
          case "lit":
            return p.s;
          case "seq": {
            const n = counters.get(idx) ?? p.start;
            counters.set(idx, n + 1);
            return String(n);
          }
          case "faker":
            return String(p.gen(f));
          case "col": {
            if (!row || !(p.name in row))
              throw new Error(
                `Template "${tpl}" references column "${p.name}", which is not ` +
                  `available yet — a template can only read columns that come ` +
                  `before it in the table.`,
              );
            const v = row[p.name];
            return v == null ? "" : String(v);
          }
        }
      })
      .join("");
}

/** Pad or truncate a string to satisfy length bounds (and varchar(n)). */
function constrainLength(
  s: string,
  col: ColumnInfo,
  check: ColumnCheck,
  f: Faker,
): string {
  const min = check.minLength ?? 0;
  let max = check.maxLength ?? Infinity;
  if (col.maxLength) max = Math.min(max, col.maxLength);
  while (s.length < min) s += f.string.alpha(min - s.length);
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/**
 * A generator that keeps a partition-key column's value inside a partition that
 * actually exists, so the parent-table insert routes successfully. Returns null
 * when no constraint is needed or we can't derive one (a DEFAULT partition
 * exists, hash partitioning, an expression key, or unparseable bounds) — the
 * caller then falls back to the ordinary generator.
 */
export function partitionKeyGenerator(
  col: ColumnInfo,
  part: PartitionInfo,
): Generator | null {
  // Only the first key column drives routing here; DEFAULT/hash/expression keys
  // accept any value, so no constraint is required.
  if (part.hasDefault || part.strategy === "hash") return null;
  if (part.keyColumns[0] !== col.name) return null;

  if (part.strategy === "list") {
    const values = (part.list ?? []).map((v) => coerce(v, col));
    if (values.length === 0) return null;
    return (f) => f.helpers.arrayElement(values);
  }

  const ranges = (part.ranges ?? []).filter(
    (r) => r.from !== null || r.to !== null,
  );
  if (ranges.length === 0) return null;
  return (f) => {
    const r = f.helpers.arrayElement(ranges);
    return valueInRange(r.from, r.to, col, f);
  };
}

/** Coerce a raw bound/list literal string to the column's JS value type. */
function coerce(raw: string, col: ColumnInfo): unknown {
  if (col.dataType === "integer" || col.dataType === "decimal")
    return Number(raw);
  if (col.dataType === "boolean") return /^(t|true|1)$/i.test(raw);
  return raw;
}

const RANGE_SPAN_MS = 1000 * 60 * 60 * 24 * 365; // ~1y fallback for open-ended time ranges
const RANGE_SPAN_NUM = 1000;

/** Generate a value within [from, to) for a RANGE partition, typed by column. */
function valueInRange(
  from: string | null,
  to: string | null,
  col: ColumnInfo,
  f: Faker,
): unknown {
  const cat = col.dataType;
  if (cat === "timestamp" || cat === "date") {
    const lo =
      from !== null
        ? new Date(from).getTime()
        : new Date(to!).getTime() - RANGE_SPAN_MS;
    const hi =
      to !== null
        ? new Date(to!).getTime()
        : new Date(from!).getTime() + RANGE_SPAN_MS;
    const d = new Date(f.number.int({ min: lo, max: Math.max(lo, hi - 1) }));
    return cat === "date" ? d.toISOString().slice(0, 10) : d;
  }
  if (cat === "integer" || cat === "decimal") {
    const lo = from !== null ? Number(from) : Number(to) - RANGE_SPAN_NUM;
    const hi = to !== null ? Number(to) : Number(from) + RANGE_SPAN_NUM;
    if (cat === "integer")
      return f.number.int({
        min: Math.ceil(lo),
        max: Math.max(Math.ceil(lo), Math.floor(hi) - 1),
      });
    return f.number.float({
      min: lo,
      max: Math.max(lo, hi),
      fractionDigits: Math.min(col.numericScale ?? 2, 6),
    });
  }
  // Text (or anything else) partitioned by range: the inclusive lower bound is a
  // valid, in-partition value — good enough without inventing an ordering.
  return from ?? to;
}

/** Coarse guard so name heuristics don't violate the column's actual type. */
function isCompatible(col: ColumnInfo): boolean {
  // Name rules produce plain strings/dates, so only apply them to columns that
  // can actually hold one. Structured (array/composite/range/json), binary
  // (bytea), network (inet), and scalar-only (numeric/boolean/uuid) types all
  // fall through to their type-specific generator instead.
  return ["text", "date", "time", "timestamp"].includes(col.dataType);
}
