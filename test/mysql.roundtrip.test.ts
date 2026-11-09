/**
 * MySQL type round-trip. Opt-in: skipped unless MYSQL_URL is set (it is in CI,
 * which runs a mysql:8 service). One throwaway database holds the `rt` table;
 * the live-insert and SQL-script paths load into it in sequence.
 *
 *   docker run -d --name my -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8
 *   MYSQL_URL=mysql://root:root@localhost:3306/ npm test
 */

import { test } from "node:test";
import mysql from "mysql2/promise";
import { introspectMysql } from "../src/mysql-introspect.js";
import { insertDataMysql, toSqlMysql } from "../src/mysql-emit.js";
import type { Connection } from "../src/types.js";
import type { TableData } from "../src/generate.js";
import { casesFor, columnClauses } from "./roundtrip/fixtures.js";
import {
  runRoundTrip,
  TEST_TIMEOUT_MS,
  type RtDb,
} from "./roundtrip/runner.js";

const url = process.env.MYSQL_URL;
const enabled = !!url;

const cases = casesFor("mysql");
const { preambles, columns } = columnClauses("mysql", cases);

async function makeDb(): Promise<RtDb> {
  const db = `rt_${Date.now()}`;
  const raw = await mysql.createConnection({
    uri: url!,
    multipleStatements: true,
  });
  await raw.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await raw.query(`CREATE DATABASE \`${db}\``);
  await raw.query(`USE \`${db}\``);
  for (const p of preambles) await raw.query(p);
  await raw.query(
    `CREATE TABLE rt (\n  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  ${columns.join(",\n  ")}\n) ENGINE=InnoDB`,
  );

  const conn: Connection = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const [rows] = await raw.query(sql, params);
      return { rows: rows as unknown as T[] };
    },
    async end() {},
  };

  return {
    introspect: () => introspectMysql(conn, [db]),
    insertLive: async (data: TableData[]) => {
      await insertDataMysql(conn, data);
    },
    loadScript: async (data: TableData[]) => {
      await raw.query(toSqlMysql(data));
    },
    reset: async () => {
      await raw.query("TRUNCATE TABLE rt");
    },
    read: async (column: string) => {
      const [rows] = await raw.query(
        `SELECT ${column} AS v FROM rt ORDER BY id`,
      );
      return (rows as Array<{ v: unknown }>).map((r) => r.v);
    },
    close: async () => {
      try {
        await raw.query(`DROP DATABASE IF EXISTS \`${db}\``);
      } catch {
        // Best-effort cleanup; always release the socket below so we never hang.
      } finally {
        await raw.end();
      }
    },
  };
}

test(
  "MySQL type round-trip (live insert ↔ SQL script)",
  { skip: !enabled, timeout: TEST_TIMEOUT_MS },
  async () => {
    await runRoundTrip("mysql", makeDb);
  },
);
