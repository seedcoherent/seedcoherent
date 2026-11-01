# seedcoherent vs. Snaplet Seed

**TL;DR** — Both understand your schema and generate referentially-correct data.
Snaplet Seed is a **code-first** framework: you install a package, run a generate
step, and write a TypeScript seed script. `seedcoherent` is a **zero-config CLI**:
one `npx` command against the database, no script to write or maintain.

## What Snaplet Seed is

[Snaplet Seed](https://github.com/supabase-community/seed) grew out of Snaplet. The
company shut down in 2024 and open-sourced its tools under the MIT license; Seed is
now maintained in the Supabase community org (Postgres, SQLite, and MySQL). Worth
knowing before you adopt it: the most recent published releases date from 2024, so
evaluate its current maintenance pace for yourself.

Seed's model is code-first. You install `@snaplet/seed`, run an introspection/code
generation step to produce a typed client from your schema, and then author a
`seed.config.ts` script that calls that client:

```ts
import { createSeedClient } from "@snaplet/seed";

const seed = await createSeedClient();
await seed.users((x) => x(1000)); // generate 1000 users
await seed.orders((x) => x(5000)); // orders linked to those users
```

That TS-native model is genuinely nice: it's type-checked, you get autocomplete for
your tables, and you can express bespoke generation logic in real code. The cost is
a build step, generated client code checked into (or regenerated in) your repo, and
a script that is one more thing to keep in sync with the schema.

## How they compare

| | seedcoherent | Snaplet Seed |
| --- | :---: | :---: |
| Reads your schema | ✅ | ✅ |
| Referentially-correct FKs | ✅ | ✅ |
| Composite & self-referential FKs | ✅ | partial |
| `UNIQUE` / `CHECK` / enum aware | ✅ | partial |
| Realistic values from column names | ✅ | ✅ |
| Setup | none — one `npx` command | install pkg + codegen step + write `seed.config.ts` |
| Typed client / autocomplete | ❌ (CLI, not a code API) | ✅ |
| Temporal & status coherence | ✅ | ❌ |
| Learn shape from real data | ✅ `--profile` | ❌ |
| Subset + anonymize production | ✅ | ❌ |
| FK fan-out skew / bounded cardinality | ✅ `--distribution` / `--cardinality` | partial |
| Databases | PG · MySQL · SQLite · **SQL Server** | PG · MySQL · SQLite |
| Output | insert · `.sql` · CSV · NDJSON | insert (via the client) |
| Determinism | ✅ `--seed` | ✅ |

## The same task, both ways

Seed 1,000 users and 5,000 orders:

**seedcoherent** — nothing to install or scaffold:

```bash
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000
```

**Snaplet Seed** — install, generate the client, then write and run a script:

```bash
npm i -D @snaplet/seed
npx @snaplet/seed init     # introspect schema → generate the typed client
# …then author seed.config.ts (see above) and run it
npx tsx seed.config.ts
```

## When to pick Snaplet Seed instead

- You **want a code-first, type-checked workflow** — a TS script with autocomplete
  over your tables, where generation logic lives in version-controlled code rather
  than CLI flags.
- You need **complex, imperative generation logic** that's awkward to express as
  flags and natural to write as a program.
- You're **already in the Supabase/Postgres ecosystem** and prefer a tool maintained
  there.

Reach for `seedcoherent` when you'd rather not write or maintain a seed script at
all, when you need SQL Server, or when you want to go beyond generation into
**subsetting and anonymizing real production data** (`--subset` + `--anonymize`) or
**matching production's statistical shape** (`--profile`) — capabilities outside
Snaplet Seed's scope.
