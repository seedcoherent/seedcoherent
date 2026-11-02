# Recipes for your stack

You already run migrations. `seedcoherent` slots in right after them: it reads
the schema your ORM just created — tables, foreign keys, `UNIQUE`/`CHECK`
constraints — and fills it with coherent, referentially-correct rows. No
per-table seed script, no hand-wiring foreign keys, nothing to keep in sync as
the schema changes.

Every recipe is the same three steps; only the connection source and the seed
hook differ per stack:

1. **Migrate** — run your stack's usual migrate command so the database has the
   schema.
2. **Seed** — `npx seedcoherent <connection> --rows <table>=<n> …` to insert
   live, or emit a `.sql` file with `-o`.
3. **Wire it in** — hang that command off your stack's existing seed command so
   your team runs one thing.

## Pick your stack

- [Prisma](./prisma.md) — hook `prisma db seed` straight at seedcoherent
- [Drizzle](./drizzle.md) — a `db:seed` npm script after `drizzle-kit migrate`
- [Django](./django.md) — seed the DB `migrate` just built (Node alongside Python)
- [Rails](./rails.md) — call it from `db/seeds.rb`, run via `rails db:seed`
- [Supabase](./supabase.md) — generate `supabase/seed.sql`, auto-loaded by `supabase db reset`

## At a glance

| Stack | Databases | Seed hook | Default recipe |
| --- | --- | --- | --- |
| Prisma | PG · MySQL · SQLite | `prisma db seed` (`package.json`) | insert live |
| Drizzle | PG · MySQL · SQLite | `db:seed` npm script | insert live |
| Django | PG · MySQL · SQLite | `make seed` / manage target | insert live or `-o seed.sql` |
| Rails | PG · MySQL · SQLite | `db/seeds.rb` → `rails db:seed` | insert live |
| Supabase | PG | `supabase/seed.sql` → `supabase db reset` | emit `-o supabase/seed.sql` |

Two flags worth knowing for every recipe:

- `--seed 42` makes output **byte-identical** across runs — reach for it in CI.
- `--on-conflict skip` (SQL output) makes a generated seed **re-runnable**
  against a database that already has some of the rows.

> **Note on Django & Rails.** `seedcoherent` is distributed on npm and run with
> `npx`, so those stacks need Node.js available next to Python/Ruby. It talks to
> the database directly over its connection string — it does **not** emit Django
> fixtures or Rails `db/seeds.rb` Ruby.

Facts about each stack were verified on 2026-11-01; if you spot something out of
date, please open an issue.
