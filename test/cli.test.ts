/**
 * CLI tests. `src/cli.ts` exports `run(argv, { exitOverride })`, so the whole
 * flag surface can be driven in-process without spawning or a live database:
 *   - validation matrix: assert the flag-compatibility guards reject with their
 *     expected message (commander throws under exitOverride instead of exiting);
 *   - no-DB generation: the `--schema-file` offline path emits SQL/NDJSON, so it
 *     exercises runOffline -> buildData -> writeMaterialized end to end;
 *   - one real-entry-point smoke test via a spawned subprocess for the exit code.
 *
 * Guards behind live-DB introspection (the --scan / --where / --append family in
 * the live branch) need a connection and are covered by the gated *-integration
 * tests, not here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";

const execFileP = promisify(execFile);

const DDL = `
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL
);
CREATE TABLE orders (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  total numeric NOT NULL
);
`;

/** Run the CLI in-process, capturing stdout/stderr and silencing them. */
async function capture(
  argv: string[],
): Promise<{ stdout: string; stderr: string; error?: Error }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realConsoleError = console.error.bind(console);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: any) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(" ") + "\n";
  };
  try {
    await run(argv, { exitOverride: true });
    return { stdout, stderr };
  } catch (err) {
    return { stdout, stderr, error: err as Error };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    console.error = realConsoleError;
  }
}

/** Write the sample DDL to a throwaway temp dir; returns the file path. */
async function withDdl(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "seedcoherent-cli-"));
  const file = join(dir, "schema.sql");
  await writeFile(file, DDL, "utf8");
  return { dir, file };
}

// --- Validation matrix ---------------------------------------------------

test("--demo rejects a connection string", async () => {
  const { error } = await capture(["--demo", "postgres://localhost/x"]);
  assert.match(error!.message, /--demo runs against a bundled example schema/);
});

test("no connection and not offline is rejected", async () => {
  // Clear DATABASE_URL so the guard isn't satisfied by the environment.
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { error } = await capture([]);
    assert.match(error!.message, /No connection string/);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("--format csv with --print is rejected (files, not stdout)", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--format",
    "csv",
    "--print",
  ]);
  assert.match(error!.message, /writes one file per table; use --out/);
});

test("--format csv without --out is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture(["--schema-file", file, "--format", "csv"]);
  assert.match(error!.message, /needs an output directory/);
});

test("unknown --format is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--format",
    "xml",
    "--print",
  ]);
  assert.match(error!.message, /Unknown --format 'xml'/);
});

test("unknown --on-conflict is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--on-conflict",
    "bogus",
    "--print",
  ]);
  assert.match(error!.message, /Unknown --on-conflict 'bogus'/);
});

test("--on-conflict with a non-sql format is rejected", async () => {
  const { dir, file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--format",
    "ndjson",
    "--on-conflict",
    "skip",
    "--out",
    dir,
  ]);
  assert.match(error!.message, /--on-conflict only applies to --format sql/);
});

test("unknown --dialect is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--dialect",
    "oracle",
    "--print",
  ]);
  assert.match(error!.message, /Unknown --dialect 'oracle'/);
});

test("--schema-file with a live-only mode (--subset) is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--subset",
    "users=10",
    "--print",
  ]);
  assert.match(error!.message, /--subset needs a live database/);
});

test("--schema-file with --append is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture([
    "--schema-file",
    file,
    "--append",
    "--print",
  ]);
  assert.match(error!.message, /--append needs a live database/);
});

test("--schema-file without an output destination is rejected", async () => {
  const { file } = await withDdl();
  const { error } = await capture(["--schema-file", file]);
  assert.match(error!.message, /pass -o <file>, --print, or --dry-run/);
});

// --- End-to-end no-DB generation -----------------------------------------

test("--schema-file --print emits INSERTs for every table", async () => {
  const { file } = await withDdl();
  const { stdout, error } = await capture([
    "--schema-file",
    file,
    "--print",
    "--seed",
    "42",
    "--rows",
    "users=3",
    "orders=5",
  ]);
  assert.equal(error, undefined, error?.message);
  assert.match(stdout, /INSERT INTO\s+"public"\."users"/i);
  assert.match(stdout, /INSERT INTO\s+"public"\."orders"/i);
});

test("--schema-file --format ndjson writes one file per table", async () => {
  const { dir, file } = await withDdl();
  const outDir = join(dir, "out");
  const { error } = await capture([
    "--schema-file",
    file,
    "--format",
    "ndjson",
    "--out",
    outDir,
    "--seed",
    "42",
    "--rows",
    "users=3",
    "orders=5",
  ]);
  assert.equal(error, undefined, error?.message);
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".ndjson"));
  assert.deepEqual(files.sort(), ["orders.ndjson", "users.ndjson"]);
  await rm(dir, { recursive: true, force: true });
});

// --- Real entry point (spawned) ------------------------------------------

test("the CLI exits non-zero when --schema-file can't be read", async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  await assert.rejects(
    execFileP(
      process.execPath,
      ["--import", "tsx", cli, "--schema-file", "/nonexistent.sql", "--print"],
      { encoding: "utf8" },
    ),
    (err: any) => {
      assert.ok(err.code !== 0, "expected non-zero exit");
      assert.match(err.stderr, /Can't read --schema-file/);
      return true;
    },
  );
});
