# Seed a Prisma database with seedcoherent

**TL;DR** — point `prisma db seed` at seedcoherent and get coherent rows for
every model with one command. It reads the schema Prisma Migrate just created,
so there's no per-model seed script to maintain.

Works with Prisma's PostgreSQL, MySQL, and SQLite providers — the same engines
seedcoherent supports.

## The recipe

After your migrations are applied:

```bash
npx prisma migrate dev          # your schema is now in the database
npx seedcoherent "$DATABASE_URL" --rows users=100 posts=500 comments=2000
```

`$DATABASE_URL` is the same variable Prisma reads from `.env`. seedcoherent
inserts in foreign-key order inside one transaction, so `posts.authorId` always
points at a real `users` row and `comments.postId` at a real `posts` row.

## Wire it into `prisma db seed`

Prisma runs whatever command you put under the `prisma.seed` key in
`package.json`. Point it at seedcoherent:

```jsonc
{
  "prisma": {
    "seed": "seedcoherent \"$DATABASE_URL\" --rows users=100 posts=500 comments=2000 --seed 42"
  }
}
```

Now the standard commands seed with coherent data:

```bash
npx prisma db seed       # run the seed directly
npx prisma migrate reset # reset, re-migrate, then auto-run the seed
```

`--seed 42` makes the output byte-identical every run, which keeps test
snapshots and CI stable.

## Re-runnable seeds

If you seed a database that may already hold some rows (a shared dev DB, a
partially-seeded CI step), emit a re-runnable SQL script instead of inserting
live:

```bash
npx seedcoherent "$DATABASE_URL" --rows users=100 posts=500 \
  --on-conflict skip -o prisma/seed.sql
```

`--on-conflict skip` renders inserts that ignore rows colliding with an existing
key, so the script is safe to apply more than once.

## Caveats

- seedcoherent fills **all** the tables it finds unless you scope with `--rows`
  per table. Prisma's internal `_prisma_migrations` table is left alone (it has
  no inbound foreign keys and you don't name it).
- Need production-shaped data (realistic null rates, FK fan-out, time windows)?
  Add `--profile` against a reference database, or shape it by hand with
  `--null-rate`, `--distribution`, and `--cardinality`. See the
  [main README](../../README.md).
