# Seed an ephemeral database in CI

**TL;DR** — spin up a fresh database in CI, run your migrations, then run
`npx seedcoherent` with `--seed 42` so every run produces the same rows.

Works with GitHub Actions service containers, docker-compose, and
Testcontainers. The snippets below use Postgres; swap the image and connection
string for MySQL or SQL Server.

## GitHub Actions

Use a `services:` container for the database, then call seedcoherent after
your migration step:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Migrate
        run: npx prisma migrate deploy   # or your own migrate command
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres

      - name: Seed
        run: npx seedcoherent "$DATABASE_URL" --rows users=500 orders=2000 --seed 42
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres

      - name: Test
        run: npm test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

`--seed 42` makes every run produce byte-identical rows, so snapshot tests
and assertions that rely on specific IDs stay stable.

### MySQL variant

```yaml
    services:
      mysql:
        image: mysql:8
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: testdb
        ports:
          - 3306:3306
        options: >-
          --health-cmd "mysqladmin ping -h localhost -uroot -proot"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10
```

```yaml
      - name: Seed
        run: npx seedcoherent "$MYSQL_URL" --rows users=500 orders=2000 --seed 42
        env:
          MYSQL_URL: mysql://root:root@127.0.0.1:3306/testdb
```

## docker-compose

Define a one-shot `seed` service that waits for the database to be healthy,
runs your migrations, then seeds:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  seed:
    image: node:20-slim
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/postgres
    volumes:
      - .:/app
    working_dir: /app
    command: >
      sh -c "npm ci &&
             npx prisma migrate deploy &&
             npx seedcoherent \"$DATABASE_URL\" --rows users=500 orders=2000 --seed 42"
    profiles:
      - seed
```

Run it once to populate the database, then leave the `db` container running
for your app or tests:

```bash
docker compose run --rm seed    # migrate + seed
docker compose up db -d         # keep the DB up for local dev
```

The `profiles: [seed]` key means `docker compose up` (with no profile flag)
starts only `db` — the seed service runs only when you ask for it.

## Testcontainers

Spin up a real Postgres container inside your test process, seed it, then
point your test suite at the connection string:

```ts
// globalSetup.ts  (Jest: globalSetup / Vitest: globalSetup)
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execaSync } from "execa";

export async function setup() {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const uri = container.getConnectionUri();

  // Run your migrations
  execaSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: uri },
  });

  // Seed with coherent, reproducible data
  execaSync("npx", [
    "seedcoherent",
    uri,
    "--rows", "users=200", "orders=1000",
    "--seed", "42",
  ]);

  // Expose the URI so test files can connect
  process.env.DATABASE_URL = uri;

  // Store container reference for teardown
  (globalThis as any).__DB_CONTAINER__ = container;
}

export async function teardown() {
  await (globalThis as any).__DB_CONTAINER__?.stop();
}
```

Wire it into your test runner:

```jsonc
// jest.config.ts
{
  "globalSetup": "./globalSetup.ts",
  "globalTeardown": "./globalSetup.ts"
}
```

```ts
// vitest.config.ts
{
  test: {
    globalSetup: "./globalSetup.ts"
  }
}
```

Install the Testcontainers package alongside your dev dependencies:

```bash
npm install --save-dev @testcontainers/postgresql execa
```

## Caveats

- **`--seed 42` is strongly recommended in CI.** Without it, seedcoherent uses
  a random seed and each run generates different row content — fine for
  smoke-testing, but it breaks snapshot assertions and makes flaky failures
  hard to reproduce.
- **Row counts.** Keep CI seeds small (hundreds, not millions) so they finish
  in a few seconds. Use larger counts only for dedicated load/perf jobs.
- **Re-running without resetting.** If the same database is reused across
  steps and may already have rows, add `--on-conflict skip` to make the seed
  idempotent.

Facts about each environment were verified on 2026-11-02; if you spot
something out of date, please open an issue.
