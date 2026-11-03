# Contributing to seedcoherent

## Prerequisites

- **Node ≥ 20** and **npm**
- **Docker** — only needed to run the full integration test suite against Postgres, MySQL, and SQL Server

## Setup

```bash
git clone https://github.com/jajjer/seedcoherent.git
cd seedcoherent
npm ci
```

## Running tests

`npm test` runs unit tests and the SQLite integration test — no database server required.

For the full integration suite, spin up the three database containers and pass their URLs:

```bash
docker run -d --name pg    -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker run -d --name mysql -e MYSQL_ROOT_PASSWORD=root   -p 3306:3306 mysql:8
docker run -d --name mssql \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest

DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
MYSQL_URL=mysql://root:root@127.0.0.1:3306/ \
MSSQL_URL='sqlserver://sa:Str0ng!Passw0rd@localhost:1433/master?encrypt=false&trustServerCertificate=true' \
npm test
```

## Format, lint, and typecheck

CI runs these checks on every PR — they must all pass:

```bash
npm run format:check   # check formatting (Prettier)
npm run format         # auto-fix formatting
npm run lint           # check linting (ESLint)
npm run lint:fix       # auto-fix lint issues
npm run typecheck      # check types (tsc --noEmit)
```

A few notes:
- `.md` files are excluded from Prettier — manual line-wrapping is intentional.
- `@typescript-eslint/no-explicit-any` is a warning, not an error — intentional for
  dynamic AST traversal patterns.
- Unused function arguments must be prefixed with `_` to satisfy the lint rule.

## Project structure

```
src/         source code (flat — dialect-specific files follow <dialect>-<concern>.ts)
test/        tests (run directly via tsx, excluded from tsconfig)
examples/    example schemas
docs/        recipes and comparison docs
```

`src/index.ts` is the library entry point; `src/cli.ts` is the CLI entry point.

## Opening a PR

1. Branch off `main`.
2. Make your change. Run `npm run format && npm run lint:fix && npm run typecheck && npm test` locally before pushing.
3. Open a PR — CI runs format → lint → typecheck → test automatically.
4. Keep PRs focused: one concern per PR.

If you're working on one of the open issues, mention it in the PR description (`Closes #N`).

## Looking for a first issue?

Issues labeled [`good first issue`](https://github.com/jajjer/seedcoherent/labels/good%20first%20issue)
are good starting points — mostly writing or small, self-contained changes with clear scope.
