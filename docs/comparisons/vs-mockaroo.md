# seedcoherent vs. Mockaroo

**TL;DR** — Mockaroo is a polished web UI for generating one table of realistic
rows at a time. `seedcoherent` reads your whole schema and generates every table at
once with foreign keys that actually resolve — no manual parent-then-child
stitching, and it runs from the command line against your database.

## What Mockaroo is

[Mockaroo](https://www.mockaroo.com) is a browser-based mock-data generator. You
define a table's columns by picking from a large catalog of field types in a
point-and-click UI, preview the rows live, and export to CSV, JSON, SQL, Excel, and
more. It's genuinely great for quickly producing a single flat dataset, and
non-engineers can use it without writing any code.

Where it stops is relationships. Mockaroo generates a table at a time and has no
native enforcement of foreign keys *across* tables. The documented way to relate
two tables is manual: generate the parent, export it, and then reference those
values when generating the child (for example by uploading the parent's CSV as a
dataset and drawing the child's key from it), or script it through the API. Keeping
a multi-table schema referentially correct this way is work you do yourself, table
by table, every time.

There's also no direct line into your database: Mockaroo produces a file (or an API
response) that you then load. And the free tier caps rows per request.

## How they compare

| | seedcoherent | Mockaroo |
| --- | :---: | :---: |
| Realistic field values | ✅ | ✅ (large catalog) |
| No-code UI | ❌ (CLI) | ✅ |
| Reads your schema automatically | ✅ introspects | ❌ you rebuild it by hand in the UI |
| Generates all tables in one pass | ✅ | ❌ one table at a time |
| Cross-table FKs resolve automatically | ✅ | ❌ manual (export parent, reuse keys) |
| Composite & self-referential FKs | ✅ | ❌ |
| `UNIQUE` / `CHECK` / enum aware | ✅ | ⚠️ per-field only, not schema-driven |
| Correct insert order | ✅ | n/a (you load files yourself) |
| Temporal & status coherence | ✅ | ❌ |
| Writes straight to the database | ✅ | ❌ export then load |
| Learn shape from real data | ✅ `--profile` | ❌ |
| Subset + anonymize production | ✅ | ❌ |
| Row limits | none | free-tier caps |
| Deterministic re-runs | ✅ `--seed` | ⚠️ limited |

## The same task, both ways

Seed users and orders where every order's `user_id` is a real user:

**seedcoherent** — one command, FKs handled:

```bash
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000
```

**Mockaroo** — roughly:

1. Build the `users` schema in the UI, generate 1,000 rows, export the CSV.
2. Re-upload that CSV as a dataset so its ids are available.
3. Build the `orders` schema, set `user_id` to draw from the uploaded users
   dataset, generate 5,000 rows, export.
4. Load both files into the database in the right order — and repeat the whole
   dance whenever the schema changes.

## When to pick Mockaroo instead

- You want a **no-code, visual tool** a non-engineer can drive, with live preview.
- You need **one flat dataset** (or a couple of loosely related ones) and don't
  need automatic cross-table referential integrity.
- You want a **quick export in an exotic format** (Excel, firebase, etc.) without
  touching a database or a terminal.
- You're assembling data by hand and value the breadth of Mockaroo's field-type
  catalog and its instant visual feedback.

Reach for `seedcoherent` when you have a real schema with foreign keys, want every
table generated and loaded in one correct pass, need to work from the command line
or CI, or want to subset/anonymize production rather than build rows from scratch.
