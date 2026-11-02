# Seed a Rails database with seedcoherent

**TL;DR** — after `rails db:migrate`, let seedcoherent fill every table with
coherent, referentially-correct rows instead of hand-writing `create!` calls in
`db/seeds.rb`.

Works with Rails' PostgreSQL, MySQL, and SQLite3 adapters.

## The recipe

After your migrations are applied:

```bash
rails db:migrate          # your schema is now in the database
npx seedcoherent "$DATABASE_URL" --rows users=100 posts=500 comments=2000 --seed 42
```

seedcoherent reads the schema Rails just migrated and inserts in foreign-key
order, so `posts.user_id` and `comments.post_id` always reference rows that
exist. Rails' pluralized table names (`users`, `posts`) are exactly what you
pass to `--rows`.

For a SQLite dev database, pass the path:

```bash
npx seedcoherent ./storage/development.sqlite3 --rows posts=500 --seed 42
```

## Wire it into `rails db:seed`

Keep the one-command habit by shelling out from `db/seeds.rb`:

```ruby
# db/seeds.rb
url = ENV.fetch("DATABASE_URL") { ActiveRecord::Base.connection_db_config.url }
system(
  "npx", "seedcoherent", url,
  "--rows", "users=100", "posts=500", "comments=2000",
  "--seed", "42"
) || abort("seedcoherent failed")
```

```bash
rails db:seed         # runs the block above
rails db:reset        # drop, re-create, migrate, then db:seed
```

`--seed 42` makes the data byte-identical across runs for stable CI and test
fixtures.

## Caveats

- seedcoherent runs via `npx` (Node), so your dev/CI environment needs Node.js
  available alongside Ruby.
- Leave Rails' bookkeeping tables (`schema_migrations`, `ar_internal_metadata`)
  out of `--rows`; run a `--dry-run` first to confirm which tables it will
  touch.
- seedcoherent writes rows straight to the database, so ActiveRecord model
  callbacks and validations do **not** fire. The values are schema-valid (FKs,
  `NOT NULL`, `UNIQUE`, `CHECK`), not model-validated — ideal for bulk,
  realistic volume; use real `create!` calls for the handful of rows that must
  satisfy app-level logic.
