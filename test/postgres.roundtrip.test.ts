/**
 * Postgres type round-trip. Opt-in: skipped unless DATABASE_URL is set (it is in
 * CI, which runs a postgres:16 service). Each database handle gets its own
 * throwaway schema so the live-insert and SQL-script paths load into isolated
 * copies of the `rt` table.
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
 */

import { test } from "node:test";
import pg from "pg";
import { introspect } from "../src/introspect.js";
import { insertInto, toSql } from "../src/emit.js";
import type { TableData } from "../src/generate.js";
import { casesFor, columnClauses } from "./roundtrip/fixtures.js";
import { runRoundTrip, type RtDb } from "./roundtrip/runner.js";

const url = process.env.DATABASE_URL;
const enabled = !!url;

const cases = casesFor("postgres");
const { preambles, columns } = columnClauses("postgres", cases);

let counter = 0;

async function makeDb(): Promise<RtDb> {
  const schema = `rt_${Date.now()}_${counter++}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  // search_path lets the bare table name and enum type in the DDL resolve here.
  await client.query(`SET search_path TO ${schema}`);
  for (const p of preambles) await client.query(p);
  await client.query(
    `CREATE TABLE rt (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${columns.join(",\n  ")}\n)`,
  );

  return {
    introspect: () => introspect(client, [schema]),
    insertLive: async (data: TableData[]) => {
      await insertInto(client, data);
    },
    loadScript: async (data: TableData[]) => {
      await client.query(toSql(data));
    },
    read: async (column: string) => {
      const res = await client.query(
        `SELECT ${column} AS v FROM ${schema}.rt ORDER BY id`,
      );
      return res.rows.map((r) => (r as { v: unknown }).v);
    },
    close: async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    },
  };
}

test(
  "Postgres type round-trip (live insert ↔ SQL script)",
  { skip: !enabled },
  async () => {
    await runRoundTrip("postgres", makeDb);
  },
);
