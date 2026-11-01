# seedcoherent vs. Faker

**TL;DR** — Faker generates realistic *values*. `seedcoherent` generates a
realistic *database*. In fact `seedcoherent` uses Faker under the hood for value
generation — it adds the schema intelligence Faker leaves to you.

## What Faker is

[Faker](https://fakerjs.dev) (`@faker-js/faker`, and its ports in most languages)
is a library of value generators: `faker.person.firstName()`,
`faker.internet.email()`, `faker.commerce.price()`, and hundreds more, across
70-plus locales. It's excellent, battle-tested, and the right tool when you need a
plausible value in code.

What it is *not* is schema-aware. Faker has no concept of your tables, your foreign
keys, your `UNIQUE` or `CHECK` constraints, or the order rows must be inserted in.
If you want to seed a database with Faker, you write all of that yourself: a script
per table, a loop that collects the parent ids you just inserted, hand-picks a
valid one for each child's foreign key, dodges unique collisions, and keeps the
insert order right. That script grows every time the schema changes.

## How they compare

| | seedcoherent | Faker alone |
| --- | :---: | :---: |
| Realistic values (names, emails, prices…) | ✅ (via Faker) | ✅ |
| Locales | ✅ `--locale de\|fr\|ja\|…` | ✅ |
| Knows your tables & columns | ✅ introspects | ❌ you hand-map each |
| Foreign keys point at real parents | ✅ automatic | ❌ you wire it |
| Composite & self-referential FKs | ✅ | ❌ |
| `UNIQUE` (single/composite) respected | ✅ | ❌ |
| `CHECK` / enum / `varchar(n)` respected | ✅ | ❌ |
| Correct insert order (FK topo sort) | ✅ | ❌ |
| Temporal coherence (`updated_at` ≥ `created_at`) | ✅ | ❌ |
| Row-internal coherence (`email` matches `first_name`) | ✅ | ❌ |
| Inserts / writes `.sql`, CSV, NDJSON | ✅ | ❌ |
| Learn shape from real data | ✅ `--profile` | ❌ |

## The same task, both ways

Seed 1,000 users and 5,000 orders whose `user_id` always points at a real user:

**seedcoherent**

```bash
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000
```

**Faker** — a sketch of the script you'd maintain yourself:

```ts
import { faker } from "@faker-js/faker";
// create 1000 users, keep their ids
const userIds: number[] = [];
for (let i = 0; i < 1000; i++) {
  const { id } = await db.insert("users", {
    email: faker.internet.email(), // must stay UNIQUE — you dedupe
    first_name: faker.person.firstName(),
    // …every column, by hand, in the right type
  });
  userIds.push(id);
}
// create 5000 orders pointing at a real user
for (let i = 0; i < 5000; i++) {
  await db.insert("orders", {
    user_id: faker.helpers.arrayElement(userIds), // the FK you wire by hand
    status: faker.helpers.arrayElement(["pending", "paid", "shipped"]), // must match the CHECK/enum
    total: faker.commerce.price(),
    created_at: faker.date.past(), // nothing stops this predating the user
  });
}
```

Every constraint the database enforces — the `UNIQUE` on `email`, the `CHECK` on
`status`, the fact that an order can't predate its customer — is your
responsibility in the Faker version, and silently wrong until an insert throws.

## When to pick Faker instead

- You need a **single value in application code** (a test fixture, a form default,
  a mock API response) — that's exactly what Faker is for, and reaching for a
  database seeding tool would be overkill.
- You're **not seeding a database at all** (in-memory objects, HTTP mocks).
- You want **full imperative control** over every generated value and are happy to
  own the wiring — Faker gives you the lowest-level building blocks.
- Your language isn't JavaScript/TypeScript and you want an in-process library
  (Faker has ports; `seedcoherent` is a CLI you point at the database).

If you're seeding a real schema, though, `seedcoherent` gives you Faker's values
*plus* the schema intelligence — for free, with zero config.
