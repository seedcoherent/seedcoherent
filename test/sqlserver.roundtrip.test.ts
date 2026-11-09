/**
 * SQL Server type round-trip. Opt-in: skipped unless MSSQL_URL is set (it is in
 * CI, which runs an mssql/server:2022 service). One throwaway schema holds the
 * `rt` table; the live-insert and SQL-script paths load into it in sequence.
 *
 *   docker run -d --name mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Str0ng!Passw0rd \
 *     -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
 *   MSSQL_URL='sqlserver://sa:Str0ng!Passw0rd@localhost:1433/master?encrypt=false&trustServerCertificate=true' npm test
 */

import { test } from "node:test";
import mssql from "mssql";
import { mssqlConfig, MssqlConnection } from "../src/dialect.js";
import { introspectMssql } from "../src/sqlserver-introspect.js";
import { insertDataMssql, toSqlMssql } from "../src/sqlserver-emit.js";
import type { TableData } from "../src/generate.js";
import { casesFor, columnClauses } from "./roundtrip/fixtures.js";
import {
  runRoundTrip,
  TEST_TIMEOUT_MS,
  type RtDb,
} from "./roundtrip/runner.js";

const url = process.env.MSSQL_URL;
const enabled = !!url;

const cases = casesFor("sqlserver");
const { preambles, columns } = columnClauses("sqlserver", cases);

async function makeDb(): Promise<RtDb> {
  const schema = `rt_${Date.now()}`;
  const pool = await new mssql.ConnectionPool(mssqlConfig(url!)).connect();
  const conn = new MssqlConnection(pool);

  await pool
    .request()
    .batch(`IF SCHEMA_ID('${schema}') IS NULL EXEC('CREATE SCHEMA ${schema}')`);
  for (const p of preambles) await pool.request().batch(p);
  await pool
    .request()
    .batch(
      `CREATE TABLE ${schema}.rt (\n  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,\n  ${columns.join(",\n  ")}\n)`,
    );

  return {
    introspect: () => introspectMssql(conn, [schema]),
    insertLive: async (data: TableData[]) => {
      await insertDataMssql(conn, data);
    },
    loadScript: async (data: TableData[]) => {
      await pool.request().batch(toSqlMssql(data));
    },
    reset: async () => {
      await pool.request().batch(`TRUNCATE TABLE ${schema}.rt`);
    },
    read: async (column: string) => {
      const res = await conn.query<{ v: unknown }>(
        `SELECT ${column} AS v FROM ${schema}.rt ORDER BY id`,
      );
      return res.rows.map((r) => r.v);
    },
    close: async () => {
      try {
        await pool
          .request()
          .batch(
            `IF OBJECT_ID('${schema}.rt','U') IS NOT NULL DROP TABLE ${schema}.rt;` +
              `IF SCHEMA_ID('${schema}') IS NOT NULL DROP SCHEMA ${schema};`,
          );
      } catch {
        // Best-effort cleanup; always release the pool below so we never hang.
      } finally {
        await pool.close();
      }
    },
  };
}

test(
  "SQL Server type round-trip (live insert ↔ SQL script)",
  { skip: !enabled, timeout: TEST_TIMEOUT_MS },
  async () => {
    await runRoundTrip("sqlserver", makeDb);
  },
);
