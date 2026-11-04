# Outreach queue — issue #51

Threads where people are asking exactly what seedcoherent solves.
Post the replies below each one. Mark `[x]` when done, then link the posted reply back in issue #51.

---

## Stack Overflow

### 1. "PostgreSQL — how to generate random number of rows of fake data with foreign key constraints?"
- **URL:** https://stackoverflow.com/questions/66250529/postgresql-how-to-generate-random-number-of-rows-of-fake-data-with-foreign-ke
- **Score:** 2 · **Answers:** 2 (accepted answer is a complex lateral join; no tool recommendation)
- **Views:** 2,668 · **Tags:** postgresql, foreign-keys, data-generation
- **Status:** [ ] not yet answered

**Suggested reply:**

> The SQL approaches above work but can get complex at scale. If you want a one-command option that handles this automatically for any schema, [seedcoherent](https://github.com/seedcoherent/seedcoherent) reads your schema's foreign keys, sorts tables in dependency order, and inserts coherent data in a single pass:
>
> ```bash
> npx seedcoherent postgres://localhost/mydb --rows suites=50 tests=200 tests_in_suites=1000
> ```
>
> It introspects the FK graph, inserts parent tables first, and fills each FK column with a real parent ID — so you never get orphan rows or constraint violations. It also handles composite keys, self-references, and circular FKs. No config files or schema mapping needed.

---

### 2. "How to create faker data with factory by typeorm-seeding?"
- **URL:** https://stackoverflow.com/questions/74579617/how-to-create-faker-data-with-factory-by-typeorm-seeding
- **Score:** 0 · **Answers:** 1 · **Views:** 2,960
- **Tags:** node.js, typescript, typeorm, faker
- **Status:** [ ] not yet answered

**Suggested reply:**

> `typeorm-seeding` with Faker works for simple tables, but as soon as you have foreign keys across multiple tables you end up manually wiring parent IDs to child rows. [seedcoherent](https://github.com/seedcoherent/seedcoherent) handles this automatically — it reads your TypeORM-managed schema (Postgres/MySQL/SQLite/SQL Server), walks the FK graph, and inserts everything in the right order:
>
> ```bash
> npx seedcoherent postgres://localhost/mydb --rows users=100 orders=500
> ```
>
> It inspects `information_schema` / `pg_catalog` directly, so it works with any schema TypeORM has migrated, without additional factory configuration. Column names like `email`, `first_name`, and `created_at` get realistic values automatically.

---

### 3. "How to generate correct fake data in Laravel 8 with two foreign key?"
- **URL:** https://stackoverflow.com/questions/67723672/how-to-generate-correct-fake-data-in-laravel-8-with-two-foreign-key
- **Score:** 0 · **Answers:** 0 · **Views:** 804
- **Tags:** php, laravel
- **Status:** [ ] not yet answered
- **Note:** This is a PHP/Laravel question — a Node.js tool isn't a fit here. Skip this one or post a PHP-idiomatic tip instead.

---

## GitHub Issues

### 4. faker-js/faker #1856 — "Generate relational data" (closed)
- **URL:** https://github.com/faker-js/faker/issues/1856
- **Status:** Closed — maintainers declined to build this into Faker
- **Comments:** 5
- **Status:** [ ] not yet commented

**Suggested comment:**

> This was closed as out-of-scope for Faker — which makes sense since Faker generates individual field values rather than whole schemas. If you landed here because you want FK-consistent relational data without writing the wiring yourself, [seedcoherent](https://github.com/seedcoherent/seedcoherent) is a zero-config CLI that does exactly this:
>
> ```bash
> npx seedcoherent postgres://localhost/mydb --rows users=500 orders=2000
> ```
>
> It reads your schema's FK graph, inserts parent tables before children, and fills FK columns with real parent IDs. It uses Faker under the hood for the field values, then adds the layer Faker leaves to you: schema introspection, correct insert order, constraint compliance (UNIQUE, CHECK, enums, varchar), and row-internal coherence (email derived from the same row's first_name/last_name). Postgres, MySQL, SQLite, and SQL Server all supported.

---

## Search queries to find more threads

Run these searches periodically to catch new questions:

### Stack Overflow (sort by newest)
```
https://stackoverflow.com/search?q=%22fake+data%22+%22foreign+key%22&tab=newest
https://stackoverflow.com/search?q=seed+postgres+faker+related+data&tab=newest
https://stackoverflow.com/search?q=generate+test+data+%22foreign+key%22&tab=newest
```

### Reddit (search, sort by new)
```
site:reddit.com/r/PostgreSQL seed data foreign key
site:reddit.com/r/node "seed" "fake data" "foreign key"
site:reddit.com/r/ExperiencedDevs database seeding realistic data
```

**Direct links:**
- https://www.reddit.com/r/PostgreSQL/search/?q=seed+fake+data+foreign+key&sort=new
- https://www.reddit.com/r/node/search/?q=seed+fake+data+foreign+key&sort=new
- https://www.reddit.com/r/django/search/?q=seed+fake+data+foreign+key&sort=new
- https://www.reddit.com/r/ExperiencedDevs/search/?q=seed+database+fake+data&sort=new

### GitHub issues to watch
```
https://github.com/faker-js/faker/issues?q=is%3Aissue+%22foreign+key%22
https://github.com/drizzle-team/drizzle-orm/issues?q=is%3Aissue+seed+fake+data
https://github.com/prisma/prisma/issues?q=is%3Aissue+seed+fake+data+foreign+key
```

---

## Outreach tips

- **Don't mass-post.** Post on threads where seedcoherent is a genuine answer. Read the question, adjust the reply to match the asker's specific schema or toolchain.
- **Mention the `--demo` mode** for people who just want to see it work immediately: `npx seedcoherent --demo` spins up a demo schema with no DB needed.
- **Link to the relevant blog post** when the question is about FK graph traversal:
  `https://dev.to/` (once published from `blog/how-we-walk-the-fk-graph.md`)
- **Reply on Reddit** as yourself, not as a tool author, unless asked. Lead with solving the problem.
