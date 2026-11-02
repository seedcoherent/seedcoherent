# Seed a Supabase project with seedcoherent

**TL;DR** — generate `supabase/seed.sql` with one command. Supabase's CLI runs
that file automatically on every `supabase db reset`, so your whole team gets
the same coherent, referentially-correct data for free.

This is the tightest fit of any stack: Supabase is Postgres, and it already has
a seed hook built for exactly this.

## The recipe

Supabase loads `supabase/seed.sql` after applying migrations on a reset. Point
seedcoherent's SQL output at that file:

```bash
npx seedcoherent "$DATABASE_URL" \
  --rows profiles=100 posts=500 comments=2000 \
  --format sql --seed 42 -o supabase/seed.sql
```

`$DATABASE_URL` is your local Supabase Postgres (from `supabase status`, or the
pooler/connection string in your project settings). seedcoherent reads the
schema, generates rows in foreign-key order, and writes a plain SQL script.
Then:

```bash
supabase db reset        # re-applies migrations, then runs supabase/seed.sql
```

`--seed 42` makes `seed.sql` deterministic, so committing it gives every teammate
and every CI run an identical database.

## No running database needed

You can generate `seed.sql` straight from your migration DDL — no database
connection — which is handy in CI or a fresh clone. Concatenate your migrations
and feed them to `--schema-file` (Postgres is the default dialect):

```bash
cat supabase/migrations/*.sql > /tmp/schema.sql
npx seedcoherent --schema-file /tmp/schema.sql \
  --rows profiles=100 posts=500 -o supabase/seed.sql
```

## Make it re-runnable

If you apply `seed.sql` to a database that isn't freshly reset, make it
idempotent so re-applying doesn't collide on primary keys:

```bash
npx seedcoherent "$DATABASE_URL" --rows profiles=100 posts=500 \
  --on-conflict skip -o supabase/seed.sql
```

## Caveats

- Seed **your** tables, not Supabase's managed schemas. `auth.users`,
  `storage.*`, and the other platform tables live outside `public` and have
  their own invariants — scope `--rows` to your `public` tables and run a
  `--dry-run` to confirm the plan before writing.
- A `profiles` row typically references `auth.users(id)`. seedcoherent keeps
  referential integrity *within the tables it generates*; if a column points at
  `auth.users`, create those auth users first (via the Supabase CLI/API) or
  relax that FK in local dev, then seed.
- Row Level Security doesn't block this path — `seed.sql` runs as the superuser
  during `db reset`, so generated rows load regardless of your policies.
