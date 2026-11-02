# Seed a Drizzle database with seedcoherent

**TL;DR** — Drizzle ships migrations but no first-party "fill my whole schema"
seed command. Add a one-line `db:seed` script that runs seedcoherent after
`drizzle-kit migrate`, and every table gets coherent, referentially-correct
rows.

Works with Drizzle's PostgreSQL, MySQL, and SQLite drivers.

## The recipe

After your migrations are applied:

```bash
npx drizzle-kit migrate          # your schema is now in the database
npx seedcoherent "$DATABASE_URL" --rows users=100 posts=500 comments=2000
```

seedcoherent reads the live schema — the same tables your Drizzle schema
defines — and inserts in foreign-key order, so no child row references a parent
that doesn't exist.

## Wire it into an npm script

Drizzle has no `db seed` subcommand, so add your own:

```jsonc
{
  "scripts": {
    "db:migrate": "drizzle-kit migrate",
    "db:seed": "seedcoherent \"$DATABASE_URL\" --rows users=100 posts=500 comments=2000 --seed 42",
    "db:reset": "npm run db:migrate && npm run db:seed"
  }
}
```

```bash
npm run db:seed
```

`--seed 42` keeps the output byte-identical across runs for stable CI and
snapshots.

## vs. `drizzle-seed`

Drizzle's official [`drizzle-seed`](https://orm.drizzle.team/docs/seed-overview)
is a code-first generator: you write a `seed(db, schema)` call and refine each
column's values with a `.refine()` builder. It's the right choice when you want
fine-grained, in-code control over every column. seedcoherent is the opposite
trade: zero config, it infers values from column names and constraints
automatically, and it runs as a CLI against any of four databases — reach for it
when you'd rather not hand-write and maintain the generator.

## Caveats

- Point `--rows` at the tables you want sized; seedcoherent fills the rest with
  a default count. Drizzle's `__drizzle_migrations` bookkeeping table has no
  inbound foreign keys, so leaving it unnamed leaves it untouched.
- For a re-runnable seed against a non-empty database, emit SQL instead of
  inserting live: `--on-conflict skip -o seed.sql`.
