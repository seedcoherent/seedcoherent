# seedcoherent vs. the alternatives

Most tools for "fake data" solve one half of the problem — they generate
realistic *values*. The hard half is generating a realistic *database*: rows whose
foreign keys point at parents that exist, whose `UNIQUE` and `CHECK` constraints
hold, and whose timestamps and statuses agree with each other. That's the gap
`seedcoherent` is built to close.

These pages compare `seedcoherent` with the tools people most often weigh it
against. They're meant to be fair — each one ends with the cases where the other
tool is the better choice.

- [vs. Faker](./vs-faker.md) — the value library `seedcoherent` is itself built on
- [vs. Snaplet Seed](./vs-snaplet.md) — the code-first seed framework now maintained under Supabase
- [vs. Mockaroo](./vs-mockaroo.md) — the web-based, row-at-a-time generator
- [vs. hand-rolled `pg_dump` sampling](./vs-pg-dump.md) — carving a slice of production by hand

## At a glance

| | seedcoherent | Faker | Snaplet Seed | Mockaroo |
| --- | :---: | :---: | :---: | :---: |
| Reads your schema automatically | ✅ | ❌ | ✅ | ❌ |
| Walks the FK graph (no orphan rows) | ✅ | ❌ (you wire it) | ✅ | ❌ (manual) |
| Composite & self-referential FKs | ✅ | ❌ | partial | ❌ |
| `UNIQUE` / `CHECK` / enum aware | ✅ | ❌ | partial | ❌ |
| Realistic values from column names | ✅ | ✅ (you map each) | ✅ | ✅ |
| Temporal & status coherence | ✅ | ❌ | ❌ | ❌ |
| Learn shape from real data (`--profile`) | ✅ | ❌ | ❌ | ❌ |
| Subset + anonymize production | ✅ | ❌ | ❌ | ❌ |
| Deterministic (`--seed`) | ✅ | ✅ | ✅ | ⚠️ limited |
| Databases | PG · MySQL · SQLite · SQL Server | n/a (library) | PG · MySQL · SQLite | via CSV/SQL export |
| Delivery | CLI / `npx`, zero config | code (any language) | code (`seed.config.ts`) | web UI / API |
| Writes to a database | ✅ | ❌ | ✅ | ❌ (export, then load) |

`✅` = built in · `⚠️` = possible with caveats · `❌` = not supported / do it yourself.
Hand-rolled `pg_dump` sampling isn't a product, so it's compared in prose on its
[own page](./vs-pg-dump.md).

Facts about the other tools were verified on 2026-10-31; if you spot something
out of date, please open an issue.
