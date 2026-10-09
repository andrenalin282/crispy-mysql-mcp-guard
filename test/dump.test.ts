// Integration test for mysql_dump. Same server requirements as db.test.ts (MMG_TEST_PORT), plus the `mariadb`/`mysql`
// CLI and database-level rights for account `u` on `t` and `t_restore` to prove the dump restores losslessly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Connections } from "../src/db.js";
import { parseConfig } from "../src/config.js";

const port = Number(process.env.MMG_TEST_PORT);
const host = process.env.MMG_TEST_HOST ?? "127.0.0.1";
const skip = !port;
const base = { host, port, database: "t", password: "pw" };
const dir = skip ? "" : mkdtempSync(join(tmpdir(), "mmg-dump-"));
let c: Connections;

const cli = () => (spawnSync("mariadb", ["--version"]).status === 0 ? "mariadb" : "mysql");
const sh = (args: string[], input?: string) =>
  spawnSync(cli(), ["-h", host, "-P", String(port), "-uu", "-ppw", ...args], { input, encoding: "utf8" });

before(async () => {
  if (skip) return;
  c = new Connections(
    parseConfig({
      connections: {
        w: { ...base, user: "u", allow: { select: true, insert: true, ddl: true } },
        ins: { ...base, user: "u", allow: { select: false, insert: true } },
      },
    }),
  );
  await c.run("w", "DROP VIEW IF EXISTS v_items");
  await c.run("w", "DROP TABLE IF EXISTS d_items");
  await c.run(
    "w",
    "CREATE TABLE d_items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), big BIGINT, bin BLOB, j LONGTEXT, d DATETIME, dbl DOUBLE, gen BIGINT AS (IFNULL(big, 0) + 1) STORED) DEFAULT CHARSET=utf8mb4",
  );
  await c.run("w", "INSERT INTO d_items (name, big, bin, j, d, dbl) VALUES (?, 9007199254740993, UNHEX('00FF27'), ?, '2024-01-02 03:04:05', 1.5)", ["a'b\\c\n\"; DROP TABLE x; --", '{"k": [1, 2]}']);
  await c.run("w", "INSERT INTO d_items (name) VALUES (NULL), ('ünï 😀')");
  await c.run("w", "CREATE VIEW v_items AS SELECT id, name FROM d_items");
  await c.run("w", "DROP TRIGGER IF EXISTS trg_items");
  await c.run("w", "CREATE TRIGGER trg_items BEFORE INSERT ON d_items FOR EACH ROW SET NEW.dbl = IFNULL(NEW.dbl, 0)");
  await c.run("w", "DROP FUNCTION IF EXISTS fn_one");
  await c.run("w", "CREATE FUNCTION fn_one() RETURNS INT DETERMINISTIC RETURN 1");
});

after(async () => {
  if (skip) return;
  await c.run("w", "DROP VIEW IF EXISTS v_items");
  await c.run("w", "DROP TABLE IF EXISTS d_items");
  await c.run("w", "DROP FUNCTION IF EXISTS fn_one");
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});

test("dump restores losslessly into another database", { skip }, async () => {
  const out = join(dir, "a.sql");
  const r = await c.dump("w", { structure: true, data: true, routines: true, outputPath: out, overwrite: false });
  assert.equal(r.tables.find((t) => t.name === "d_items")?.rows, 3);
  assert.deepEqual(r.views, ["v_items"]);
  assert.deepEqual(r.triggers, ["trg_items"]);
  assert.deepEqual(r.routines, ["function fn_one"]);
  assert.equal(r.bytes, readFileSync(out).length);

  const sql = readFileSync(out, "utf8");
  assert.ok(!sql.includes("`gen`) VALUES") && !/INSERT INTO `d_items` \([^)]*gen/.test(sql), "generated column must not be inserted");

  const prep = sh(["-e", "DROP DATABASE IF EXISTS t_restore; CREATE DATABASE t_restore"]);
  assert.equal(prep.status, 0, prep.stderr + " (account u needs rights on t_restore)");
  const res = sh(["t_restore"], sql);
  assert.equal(res.status, 0, res.stderr);
  const q = "SELECT id, name, big, HEX(bin), j, d, dbl, gen FROM d_items ORDER BY id";
  const a = sh(["-N", "-B", "t", "-e", q]);
  const b = sh(["-N", "-B", "t_restore", "-e", q]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.stdout, a.stdout);
  assert.ok(a.stdout.includes("9007199254740993") && a.stdout.includes("0".repeat(0) + "00FF27"));
  const objs = sh(["-N", "-B", "t_restore", "-e", "SELECT fn_one(), (SELECT COUNT(*) FROM v_items), (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='t_restore')"]);
  assert.equal(objs.stdout.trim(), "1\t3\t1", objs.stderr);
  sh(["-e", "DROP DATABASE t_restore"]);
});

test("options: structure only, data only, table filter", { skip }, async () => {
  const s = await c.dump("w", { structure: true, data: false, routines: false, outputPath: join(dir, "s.sql"), overwrite: false });
  assert.ok(!readFileSync(s.path, "utf8").includes("INSERT INTO"));
  const d = await c.dump("w", { structure: false, data: true, routines: false, tables: ["d_items"], outputPath: join(dir, "d.sql"), overwrite: false });
  const sql = readFileSync(d.path, "utf8");
  assert.ok(!sql.includes("CREATE TABLE") && sql.includes("INSERT INTO"));
  await assert.rejects(c.dump("w", { tables: ["nope"], structure: true, data: true, routines: true, outputPath: join(dir, "n.sql"), overwrite: false }), /Unknown table/);
  assert.ok(!existsSync(join(dir, "n.sql")));
});

test("guards: select permission, path rules, overwrite, symlink", { skip }, async () => {
  const o = { structure: true, data: true, routines: true, overwrite: false };
  await assert.rejects(c.dump("ins", { ...o, outputPath: join(dir, "x.sql") }), /does not allow: select/);
  await assert.rejects(c.dump("w", { ...o, outputPath: "rel.sql" }), /absolute/);
  await assert.rejects(c.dump("w", { ...o, outputPath: join(dir, "x.txt") }), /\.sql/);
  await assert.rejects(c.dump("w", { ...o, outputPath: join(dir, "nodir", "x.sql") }), /Directory does not exist/);
  await assert.rejects(c.dump("w", { ...o, outputPath: join(dir, "a.sql") }), /File exists/);
  const target = join(dir, "victim.sql");
  writeFileSync(target, "keep");
  symlinkSync(target, join(dir, "link.sql"));
  await assert.rejects(c.dump("w", { ...o, overwrite: true, outputPath: join(dir, "link.sql") }), /non-regular/);
  assert.equal(readFileSync(target, "utf8"), "keep");
  const again = await c.dump("w", { ...o, overwrite: true, outputPath: join(dir, "a.sql") });
  assert.ok(again.bytes > 0);
});

test("literal serialises parsed JSON (object/array) back to quoted JSON text", async () => {
  const { literal } = await import("../src/dump.js");
  assert.equal(literal({ a: 1, b: [2] }), `'{\\"a\\":1,\\"b\\":[2]}'`);
  assert.equal(literal([1, 2]), "'[1,2]'");
  assert.equal(literal(null), "NULL");
  assert.equal(literal("x"), "'x'");
});
