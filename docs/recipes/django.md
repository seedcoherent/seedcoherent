# Seed a Django database with seedcoherent

**TL;DR** — after `manage.py migrate`, point seedcoherent at the same database
and it fills every table with coherent, referentially-correct rows — no
`fixtures/*.json` to write or keep in sync with your models.

Works with Django's PostgreSQL, MySQL, and SQLite backends.

## Not `loaddata` — direct to the database

Django's built-in seeding is `manage.py loaddata`, which loads **fixtures** you
hand-write as JSON/YAML. seedcoherent does **not** emit Django fixtures; it
connects to the database directly over a connection string (just like your app
does) and inserts rows, or writes a `.sql` script. So the flow is "migrate, then
seed the database," not "generate a fixture, then `loaddata`."

## The recipe

Build a connection string from your `DATABASES['default']` settings. For the
common Postgres case:

```bash
python manage.py migrate     # your schema is now in the database
npx seedcoherent "postgres://USER:PASS@HOST:5432/DBNAME" \
  --rows accounts_user=100 blog_post=500 blog_comment=2000 --seed 42
```

Table names are Django's generated ones — `<app_label>_<model>` (e.g.
`blog_post`), or whatever you set via `Meta.db_table`. seedcoherent inserts in
foreign-key order, so `blog_post.author_id` always resolves to a real
`accounts_user` row.

For a SQLite project, pass the file path straight through:

```bash
npx seedcoherent ./db.sqlite3 --rows blog_post=500 --seed 42
```

## Wire it in

seedcoherent runs via `npx` (Node), so your project needs Node.js installed
alongside Python. A `Makefile` target keeps it one command for the team:

```makefile
seed:
	python manage.py migrate
	npx seedcoherent "$(DATABASE_URL)" --rows blog_post=500 blog_comment=2000 --seed 42
```

```bash
make seed
```

If you prefer not to add Node to a runtime image, generate the seed offline once
and commit the SQL:

```bash
npx seedcoherent "$DATABASE_URL" --rows blog_post=500 -o seed.sql
# later, with no Node needed:
psql "$DATABASE_URL" -f seed.sql
```

## Caveats

- Don't name Django's framework tables (`django_migrations`, `auth_permission`,
  `django_content_type`, …) in `--rows`. seedcoherent will still size them to a
  default unless excluded — scope `--rows` to your app tables, and review a
  `--dry-run` first to see exactly which tables it plans to touch.
- `auth_user` password hashes and other app-level invariants aren't Django-aware
  — seedcoherent generates schema-valid values, not values Django's ORM
  validators would produce. Seed app-domain tables with it; create real
  superusers with `createsuperuser`.
