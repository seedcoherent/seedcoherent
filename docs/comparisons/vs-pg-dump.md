# seedcoherent vs. hand-rolled `pg_dump` sampling

**TL;DR** — The usual DIY way to fill a staging or CI database is to take a slice
of production with `pg_dump` and a pile of `WHERE` clauses. It works, but you own
two hard problems by hand: keeping the slice referentially complete, and scrubbing
the PII. `seedcoherent`'s `--subset` + `--anonymize` does both for you.

## What `pg_dump` sampling is

`pg_dump` is the right tool for a *full* backup or restore. People stretch it into
*sampling* when they want a small, realistic staging dataset: dump selected tables,
or pipe `COPY (SELECT … WHERE …)` per table, then load the result elsewhere. It's
free, it's already installed, and the data is 100% real — the shapes and
distributions are exactly production's, because it *is* production.

The trouble is two-fold:

1. **Referential completeness is on you.** If you take "the last 30 days of
   orders," you must also pull every `user`, `product`, and `category` those orders
   reference — and everything *those* rows reference — or the restore fails on
   foreign keys (or, worse, you disable FK checks and load orphaned rows). Writing
   and maintaining that transitive closure by hand, across a changing schema, is
   fiddly and easy to get subtly wrong.
2. **It's real PII.** A production dump carries real names, emails, and payment
   details into an environment that usually shouldn't hold them. Anonymizing it
   means a second pass of hand-written `UPDATE`s that you must keep in sync with
   every PII column — and one missed column is a leak.

## How they compare

| | seedcoherent `--subset` | hand-rolled `pg_dump` |
| --- | :---: | :---: |
| Real production-shaped data | ✅ (real rows, scrubbed) | ✅ (real rows) |
| Referentially-complete slice | ✅ automatic FK closure | ❌ you write it, per table |
| Composite & self-referential FKs closed over | ✅ | ❌ manual |
| PII anonymized | ✅ `--anonymize` / `--scrub-keys` | ❌ hand-written `UPDATE`s |
| Consistent scrubbing (same value → same fake) | ✅ | ❌ |
| Join keys stay intact after scrubbing | ✅ keys passed through / remapped | ⚠️ manual |
| Targeted slice (recent / one tenant) | ✅ `--where` | ✅ (SQL you write) |
| Random sample | ✅ `--sample` | ⚠️ manual |
| Pre-copy privacy report | ✅ `--scan` | ❌ |
| Preview without writing | ✅ `--dry-run` (exact counts) | ❌ |
| Multi-engine | PG · MySQL · SQLite · SQL Server | Postgres only |

## The same task, both ways

Pull 500 orders and everything they reference into staging, anonymized:

**seedcoherent** — closure and scrubbing handled, nothing written back to prod:

```bash
npx seedcoherent $PROD_URL --subset orders=500 --to $STAGING_URL --seed 42

# Only recent orders, still fully referentially complete:
npx seedcoherent $PROD_URL \
  --subset orders=500 --where orders="created_at > now() - interval '30 days'" \
  --to $STAGING_URL

# See exactly what would be copied — and what gets scrubbed — first:
npx seedcoherent $PROD_URL --subset orders=500 --scan
```

`--subset` walks foreign keys upward to a fixpoint so every referenced parent is
pulled in (zero dangling FKs), and `--anonymize`/`--scrub-keys` replaces PII
consistently while passing key columns through so joins still resolve. A subset run
**never writes back to the source** — it requires `--to`, `--out`, or `--print`.

**`pg_dump`** — the honest sketch:

```bash
# Dump a few tables whole…
pg_dump $PROD_URL -t users -t products -t categories --data-only > parents.sql
# …then the orders you want — but now you must hand-filter the parents down to
# only the rows these orders reference, or you've dumped the whole users table.
psql $PROD_URL -c "\copy (SELECT * FROM orders WHERE created_at > now() - interval '30 days') TO 'orders.csv' CSV"
# …load into staging in FK order, then run your own UPDATE statements over every
# PII column in every table to scrub names, emails, phone numbers, …
```

## When `pg_dump` is still the right call

- You need a **true backup or full restore** — that's exactly `pg_dump`'s job, not
  something to reach for a sampling tool for.
- You need the **unmodified real data** in a trusted environment (e.g. debugging a
  production incident on a secure replica), where anonymization would hide the very
  thing you're chasing.
- Your slice is **trivially simple** — a table or two with no foreign keys to close
  over and no PII — so the closure and scrubbing problems don't arise.
- You want **exact byte-level fidelity** of production rows, not
  realistic-but-synthetic values.

For the common case — a safe, referentially-complete, PII-scrubbed staging or CI
dataset — `seedcoherent --subset` turns a bespoke, error-prone pipeline into one
command.
