# Why your seed script keeps generating orphan rows (and how to fix it)

You ask Faker to seed 500 users and 5 000 orders. It runs. No errors.

Then you try to query:

```sql
SELECT u.name, COUNT(o.id)
FROM orders o
JOIN users u ON u.id = o.user_id
GROUP BY u.name;
```

Half the orders vanish. `o.user_id` has values like `3842`, `9174`, `12001` — user IDs that don't exist. You have orphan rows.

The root cause is simple: Faker doesn't know what your foreign keys *mean*. It generates a random integer for `user_id` — the right type, the wrong value. The FK constraint only catches this if you kept it enabled during seeding; most scripts disable it, or use SQLite where FK enforcement is off by default.

This post explains how `seedcoherent` solves it by actually reading your schema and walking the FK graph.

---

## Step 1: Read the schema before writing a single row

Random generators assume a table is an isolated list of columns. `seedcoherent` starts differently — by introspecting the live database to build a complete picture of every table, every column, and every foreign-key relationship.

On Postgres, that means querying `pg_constraint` for every FK:

```sql
-- simplified from src/introspect.ts
SELECT
  conkey,       -- int2[] of child column attribute numbers
  confkey,      -- int2[] of parent column attribute numbers
  ...ref_schema, ref_table...
FROM pg_constraint
WHERE contype = 'f'
```

`conkey` and `confkey` are arrays of attribute numbers — position-based column identifiers. We resolve them to column names via `pg_attribute`, keeping the two arrays positionally aligned. That matters for composite keys (more on that shortly).

The result is a uniform `ForeignKey` structure used across all four engines:

```typescript
interface ForeignKey {
  columns: string[];    // child-side columns:  ["pa", "pb"]
  refTable: string;     // "public.parent"
  refColumns: string[]; // parent-side columns: ["a",  "b"]
}
```

SQLite uses `PRAGMA foreign_key_list(table)`. MySQL queries `information_schema.KEY_COLUMN_USAGE` ordered by `ORDINAL_POSITION`. SQL Server queries `sys.foreign_key_columns`. All produce the same shape.

---

## Step 2: Topological sort (Kahn's algorithm)

Once we have every FK, we know the dependency graph: a child table can't be populated until its parent table has rows to reference.

We sort tables using Kahn's algorithm (`src/graph.ts`):

1. Build a dependency set for each table: the set of parent tables it has FKs into.
2. Collect all tables with an empty dependency set ("ready" tables).
3. Emit them, mark them as placed, and remove them from every other table's dependency set.
4. Repeat until the queue is empty.

```typescript
while (remaining.size > 0) {
  const ready = [...remaining].filter((key) =>
    [...deps.get(key)!].every(
      (dep) => placed.has(dep) || !remaining.has(dep),
    ),
  );
  // emit ready tables, then loop
}
```

The output is a `TableInfo[]` where every parent appears before every child. The generator then processes tables in this order, so when we're generating rows for `orders`, the `users` pool already exists and we can sample from it.

---

## Step 3: Sampling — not inventing — FK values

For each child table, we pre-build a *sampler* for every FK: a function that picks a random row from the already-generated parent pool.

When generating a row for `orders`, the `user_id` column hits the FK path:

```typescript
const sample = fkSamplers.get(fk);
parent = sample ? sample(faker) : null; // random row from users pool
fkParents.set(fk, parent);             // cache it for this row
// ...
return parent[refCol];                 // parent["id"]
```

The result is always a user ID that exists. No orphans.

---

## Composite foreign keys: one parent, all columns

A composite FK is one where multiple child columns together reference multiple parent columns:

```sql
CREATE TABLE order_items (
  order_id    INT,
  product_id  INT,
  warehouse   TEXT,
  FOREIGN KEY (order_id, warehouse) REFERENCES warehoused_orders (id, warehouse)
);
```

Here `order_id` and `warehouse` must come from the **same** parent row. If you generate them independently, `(order_id=1, warehouse='EU')` might not match any parent row even if both values exist elsewhere.

The fix is a row-level cache (`fkParents: Map<ForeignKey, Row | null>`). The first time we visit any column of a composite FK, we select a parent row and store it. When we visit the second column of the same FK, we retrieve the cached row:

```typescript
let parent = fkParents.get(fk);
if (parent === undefined && !fkParents.has(fk)) {
  parent = sample(faker); // selected once
  fkParents.set(fk, parent);
}
return parent[fk.refColumns[idx]]; // idx = this column's position in the FK
```

Both `order_id` and `warehouse` come from the same `warehoused_orders` row, so the composite FK constraint always holds.

---

## Self-referential foreign keys: trees and hierarchies

A category table with a `parent_id` column referencing itself is common:

```sql
CREATE TABLE categories (
  id        SERIAL PRIMARY KEY,
  name      TEXT,
  parent_id INT REFERENCES categories(id)
);
```

There's no "parent table" to generate first here — the table references itself. We detect self-references in `topoSort` and mark them `cyclic`, but we still give the table an order slot (there's no blocking dep to wait on).

Inside the generator, self-refs have their own path:

```typescript
if (fk.refTable === table.key) {
  if (rowIndex === 0)
    // Row 0 can only reference itself — point at its own (about-to-be-assigned) PK.
    return nonNull ? nextIdPeek(table, nextId) : null;

  if (!nonNull && faker.datatype.boolean({ probability: 0.6 })) return null;

  // Every subsequent row references a uniformly sampled earlier row in this batch.
  const parent = faker.helpers.arrayElement(currentRows.slice(0, rowIndex));
  return parent[refCol];
}
```

Row 0 is the special case: a NOT NULL self-reference must resolve to itself. We peek at the integer PK this row is about to receive (the next value in the sequence) and use it. Rows 1–N either get `null` (60% of the time for nullable columns) or reference a uniformly sampled earlier row, producing a realistic tree structure.

---

## True cycles: when two tables reference each other

Self-references are common. Two-table cycles are rarer but real:

```sql
CREATE TABLE employees (
  id         SERIAL PRIMARY KEY,
  manager_id INT REFERENCES employees(id),     -- self-ref
  dept_id    INT NOT NULL REFERENCES departments(id)
);
CREATE TABLE departments (
  id      SERIAL PRIMARY KEY,
  head_id INT REFERENCES employees(id)         -- back-reference
);
```

`employees` depends on `departments`, and `departments` depends on `employees`. Kahn's algorithm reaches a point where nothing is "ready" because every remaining node has an unmet dep.

The cycle-breaker fires:

```typescript
if (ready.length === 0) {
  // Pick the node with the fewest unmet deps and emit it first.
  const next = [...remaining].sort(
    (a, b) =>
      [...deps.get(a)!].filter(d => remaining.has(d)).length -
      [...deps.get(b)!].filter(d => remaining.has(d)).length,
  )[0];
  for (const key of remaining) cyclic.add(key); // mark everything remaining
  order.push(schema.tables.get(next)!);
  ...
}
```

Say `employees` ends up first. When we generate `employees`, `departments` hasn't been generated yet, so `dept_id` has no parent pool to sample from.

If `dept_id` is NOT NULL, the generator refuses to silently emit a NULL or a made-up value. Instead it fails with a clear error:

```
Can't satisfy 1 NOT NULL foreign key(s); the parent has no rows when
the child is generated:

  public.employees (dept_id) → public.departments — NOT NULL FK cycle

Make the FK column nullable, give the parent rows (don't --skip it /
set a non-zero count), or for a true cycle use a DEFERRABLE constraint.
```

The fix is to make `departments.head_id` nullable (which it already is in the example above), and optionally `employees.dept_id` nullable if the schema allows it. With the nullable escape hatch, `employees` rows are inserted with `dept_id = NULL`, then `departments` rows are inserted referencing those employees, and a second-pass update (or a `DEFERRABLE INITIALLY DEFERRED` FK constraint) can link `employees.dept_id` afterward.

---

## Everything in one transaction

The whole pipeline runs inside a single transaction.

On Postgres, we use `COPY … FROM STDIN` for each table in topological order — it's orders of magnitude faster than individual INSERTs for large datasets. The transaction sequence looks like:

```
BEGIN;
[optional: TRUNCATE departments, employees, ... in REVERSE topo order]
COPY public.users (id, name, email) FROM STDIN;
<binary stream of rows>
\.
COPY public.orders (id, user_id, total) FROM STDIN;
<binary stream of rows>
\.
-- reset sequences so the next INSERT continues from the right id
SELECT setval(pg_get_serial_sequence('public.users', 'id'), MAX(id)) FROM public.users;
SELECT setval(pg_get_serial_sequence('public.orders', 'id'), MAX(id)) FROM public.orders;
COMMIT;
```

If anything fails — a constraint violation, a mid-stream error, a timeout — the whole transaction rolls back. You never end up with a half-seeded database.

SQLite, MySQL, and SQL Server use batched multi-row INSERTs under the same transaction instead of COPY, but the all-or-nothing guarantee is identical.

---

## What this means in practice

The result of walking the FK graph instead of ignoring it:

- **Zero orphan rows.** Every FK value is sampled from a row that actually exists.
- **Composite keys just work.** All columns of a composite FK always come from the same parent row.
- **Self-referential tables generate valid trees.** Row 0 roots the tree; subsequent rows hang off earlier rows.
- **Cycles are handled explicitly.** You get an actionable error instead of silently broken data or a constraint violation.
- **One transaction.** No partial states, no half-seeded databases.

To see it on a real schema (no database required):

```bash
npx seedcoherent --demo
```

The `--demo` schema includes users, orders, products, order items (composite FK on `order_id` + `product_id`), and an `order_status_log` with a self-referential `previous_log_id`. Everything comes out coherent.
