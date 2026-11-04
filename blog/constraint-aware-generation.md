# Your fake data is the right shape and the wrong value

Your schema says exactly what a valid row looks like:

```sql
CREATE TABLE orders (
  id       SERIAL PRIMARY KEY,
  status   TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total    NUMERIC NOT NULL CHECK (total > 0)
);
```

Then you ask Faker for 1 000 orders. It cheerfully produces `status = 'Lorem ipsum'` and `total = -4821.55`. Both are the right *type* — a string and a number — and both are values the database will reject the instant you try to insert them:

```
ERROR:  new row for relation "orders" violates check constraint "orders_status_check"
```

If you're lucky, the insert fails loudly. If you seeded SQLite, or disabled checks for speed, the bad data lands silently and breaks a test three weeks later.

The root cause is the same one behind orphaned foreign keys ([previous post](./how-we-walk-the-fk-graph.md)): a random generator doesn't read your schema. `seedcoherent` does. This post walks through how it turns `CHECK`, enum, `varchar(n)`, domain, and composite `UNIQUE` constraints into values that fit on the first try.

---

## The pipeline: introspect → distill → shape → dedup

Four stages, each a small, separately testable step:

1. **Introspect** every constraint into a uniform shape, no matter which database it came from.
2. **Distill** each `CHECK` expression into a compact per-column bounds object.
3. **Shape** the generator so its output lands inside those bounds.
4. **Dedup** composite `UNIQUE`/`PRIMARY KEY` tuples as rows are assembled.

---

## Step 1: Read the constraints before generating a value

On Postgres, one query over `pg_constraint` pulls primary keys, uniques, foreign keys, and checks at once. The interesting part is how a `CHECK` arrives: we read it back with `pg_get_expr`, which hands us a *normalized* form — fully parenthesized, with explicit casts:

```
(status)::text = ANY (ARRAY['pending'::text, 'paid'::text, ...])
(total > (0)::numeric)
(char_length((name)::text) >= 3)
```

Enum labels come from `pg_enum` (ordered by `enumsortorder`, so the labels keep their declared order), `varchar(n)` limits from `information_schema._pg_char_max_length`, and `numeric(p, s)` from the matching precision/scale helpers. Each lands on a uniform `ColumnInfo` (`src/types.ts`):

```typescript
interface ColumnInfo {
  name: string;
  dataType: string;        // broad category: "integer", "decimal", "text", "enum", ...
  maxLength: number | null;    // varchar(n)
  enumValues: string[] | null; // enum labels, in declared order
  numericPrecision: number | null;
  numericScale: number | null;
  // ...
}
```

The other three engines produce the *same* shapes. SQLite has no catalog for checks, so we scan the stored `CREATE TABLE` text for balanced `CHECK (...)` expressions. MySQL reads `information_schema.CHECK_CONSTRAINTS` (wrapped in a try/catch — the view only exists on 8.0.16+). SQL Server reads `sys.check_constraints`. Each engine then runs its raw text through a small normalizer so it looks like the Postgres shape — the key move being `rewriteInLists` in `src/checks.ts`, which turns the SQL-standard `col IN (a, b, c)` into the `col = ANY (ARRAY[a, b, c])` form the parser understands:

```typescript
// col IN ('a','b')  ->  col = ANY (ARRAY['a','b'])
// A subquery — IN (SELECT ...) — isn't a value list, so it's left alone.
export function rewriteInLists(s: string): string { /* ... */ }
```

SQL Server needs one extra step: it stores `status IN ('a','b')` as an expanded OR-chain, `([status]='a' OR [status]='b')`, which a `collapseOrEqualities` pass folds back into a membership set. The payoff is that every engine's membership check lands in one code path.

---

## Step 2: Distill each CHECK into bounds

`parseChecks` (`src/checks.ts`) turns a table's raw check expressions into a `Map<column, ColumnCheck>`. It peels the outer parens, splits top-level `AND` conjuncts, and runs each clause through four recognizers in order:

```typescript
function parseClause(clause: string) {
  return (
    parseMembership(inner) ??  // col = ANY (ARRAY[...])      -> { in: [...] }
    parseLength(inner) ??      // char_length(col) >= 3       -> { minLength: 3 }
    parseRegex(inner) ??       // col ~ '^\d{5}$'             -> { pattern: ... }
    parseComparison(inner)     // col > 0  (either operand order) -> { min, max, ... }
  );
}
```

The result is a `ColumnCheck` (`src/types.ts`):

```typescript
interface ColumnCheck {
  in?: (string | number)[];      // membership set
  min?: number; max?: number;    // numeric range
  minExclusive?: boolean; maxExclusive?: boolean;
  minLength?: number; maxLength?: number; // from char_length / length
  pattern?: string;              // POSIX regex from `col ~ '...'`
}
```

When several clauses touch the same column, `mergeCheck` keeps the *tightest* of each: the larger `min`, the smaller `max`, the intersection of two `in` sets. So `CHECK (age >= 0 AND age < 150)` collapses to a single `{ min: 0, minExclusive: false, max: 150, maxExclusive: true }`.

The governing principle is written at the top of the file, and it matters:

> Anything it can't confidently parse is skipped — leaving that column exactly as unconstrained as it was before, never producing a wrong bound.

That's why `parseComparison` bails on `<>`/`!=` (those can't bound a range), and why MySQL `REGEXP` and SQLite `LIKE` are deliberately *not* parsed — only the Postgres `~` regex is. A column we can't reason about safely is left to the ordinary generator. We never invent a bound that might be wrong.

---

## Step 3: Shape the generator to fit

Every non-FK column gets a base generator from name/type heuristics (a column called `email` gets emails, an `integer` gets integers). When a `ColumnCheck` exists, `applyCheck` (`src/infer.ts`) wraps that base so its output lands in-bounds. The branches, in precedence order:

**Membership — draw from the allowed set.**

```typescript
if (check.in && check.in.length > 0) {
  // An IN-set may co-exist with a range/length/pattern; keep only members
  // that satisfy those too.
  const narrowed = check.in.filter((v) => allowedByCheck(v, check));
  const values = narrowed.length > 0 ? narrowed : check.in;
  return (f) => f.helpers.arrayElement(values);
}
```

A `status IN ('pending', 'paid', ...)` column now yields one of exactly those five strings.

**Numeric range — honor inclusive vs. exclusive.**

```typescript
function boundedNumber(col, check): Generator {
  // integer path
  let lo = check.min !== undefined
    ? Math.ceil(check.min) + (check.minExclusive ? 1 : 0) : undefined;
  let hi = check.max !== undefined
    ? Math.floor(check.max) - (check.maxExclusive ? 1 : 0) : undefined;
  // ... decimals use eps = 10^-scale and clamp to numeric(p,s)'s magnitude
  return (f) => f.number.int({ min, max });
}
```

`CHECK (total > 0)` becomes `f.number.float({ min: 0.01, ... })` — strictly positive, never `0`, never negative. The decimal path also clamps an open-ended range to what `numeric(p, s)` can physically hold, so an unbounded `price > 0` can't overflow the column.

**Regex — match the pattern.** A small built-in sampler handles the anchored patterns real domain checks use (digit runs, character classes, quantifiers, simple alternation), so `^\d{5}$` emits exactly five digits. If a pattern is recognized but too complex to sample, we retry the base generator against the compiled `RegExp` rather than fall through to unconstrained text.

**Length / `varchar(n)` — pad and truncate.** `constrainLength` honors a `char_length` check and the column's declared width together:

```typescript
function constrainLength(s, col, check, f): string {
  const min = check.minLength ?? 0;
  let max = check.maxLength ?? Infinity;
  if (col.maxLength) max = Math.min(max, col.maxLength); // varchar(n) tightens it
  while (s.length < min) s += f.string.alpha(min - s.length);
  if (s.length > max) s = s.slice(0, max);
  return s;
}
```

### Enums and domains fall out of the same machinery

A native enum column needs no `CHECK` at all — its labels are on `ColumnInfo.enumValues`, and the generator draws straight from them:

```typescript
if (col.dataType === "enum") return (f) => f.helpers.arrayElement(col.enumValues!);
```

A `CHECK (status IN (...))` is the same idea expressed differently — it becomes `check.in` and takes the membership branch above. Either way you get a valid label.

Domains get the most satisfying treatment. A Postgres domain carries its own checks, written against the `VALUE` keyword:

```sql
CREATE DOMAIN us_zip AS text CHECK (VALUE ~ '^\d{5}$');
```

When a column uses that domain, the introspector rewrites `VALUE` to the column name and attaches the check to the table:

```typescript
if (rt.domainOid) {
  for (const expr of domainChecks.get(rt.domainOid) ?? [])
    table.checks.push({ expr: expr.replace(/\bVALUE\b/g, `"${col.name}"`) });
}
```

So `VALUE ~ '^\d{5}$'` becomes `"zip" ~ '^\d{5}$'` and flows through the exact same regex path — no domain-specific generation code anywhere.

---

## Step 4: Composite UNIQUE — dedup tuples, not columns

A `UNIQUE (order_id, product_id)` isn't satisfied by making each column unique; it's the *pair* that must not repeat. The generator tracks a seen-set per unique constraint — primary key included — keyed on the serialized tuple (`src/generate.ts`):

```typescript
const uniqueSets = [table.primaryKey, ...table.uniques].filter((u) => u.length > 0);
const seen = uniqueSets.map(() => new Set<string>());
// ...
const keys = uniqueSets.map((cols) =>
  cols.map((c) => serializeKey(candidate[c])).join("\u0001"),
);
const collision = keys.some((k, idx) => seen[idx].has(k));
if (!collision) {
  keys.forEach((k, idx) => seen[idx].add(k));
  row = candidate;  // keep it
}
```

A colliding candidate is regenerated (up to a retry cap). In append mode the sets are pre-seeded from the rows already in the target table, so a freshly generated row can't collide with persisted data either. And if a unique set genuinely runs out of distinct combinations before the requested row count, we stop and say so:

```
seedcoherent: public.order_items produced 40 of 100 requested rows — a UNIQUE
constraint can't yield more distinct values. Lower this table's count or widen
the unique column's domain.
```

An actionable message beats a duplicate-key crash halfway through a load.

---

## Before and after

The bundled demo schema carries exactly these constraints — a `price > 0`, a `status IN (...)` enum-via-check, a `quantity > 0`, and `UNIQUE` on `slug` and `email`:

| Column | Constraint | Random generator | `seedcoherent` |
| --- | --- | --- | --- |
| `products.price` | `CHECK (price > 0)` | `-4821.55` → rejected | `216.01` |
| `orders.status` | `CHECK (status IN (...))` | `'Lorem ipsum'` → rejected | `'shipped'` |
| `order_items.quantity` | `CHECK (quantity > 0)` | `0` / `-7` → rejected | `47` |
| `users.email` | `UNIQUE` | duplicate on collision | distinct every row |

See it yourself — no database required:

```bash
npx seedcoherent --demo
```

Every `status` comes out of the five-value set, every `price` and `quantity` is positive, and every `email`/`slug` is distinct. The rows are valid before they ever reach a database.

---

## What this buys you

Reading constraints instead of ignoring them means:

- **Zero rejected inserts** from out-of-range numbers, bad enum labels, over-length strings, or malformed domains.
- **One introspection pass, every engine.** CHECK, enum, `varchar(n)`, domain, and composite `UNIQUE` are read uniformly across Postgres, MySQL, SQLite, and SQL Server.
- **Conservative by construction.** A constraint we can't parse confidently leaves the column exactly as unconstrained as before — we never fabricate a bound that could itself be wrong.
- **Composite keys handled as tuples**, with a clear message when a domain is genuinely too small for the requested count.

Point it at your own schema and the same logic applies to your checks:

```bash
npx seedcoherent "postgres://localhost/mydb" --rows 1000
```
