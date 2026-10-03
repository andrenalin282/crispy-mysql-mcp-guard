// Integration test. Needs a MySQL/MariaDB server with a database `t`, an account `u` (all privileges on t)
// and an account `ro` (SELECT only on t), both with password `pw`.
// MMG_TEST_HOST (default 127.0.0.1) and MMG_TEST_PORT select the server; without MMG_TEST_PORT the test is skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Connections } from "../src/db.js";
import { parseConfig } from "../src/config.js";

const port = Number(process.env.MMG_TEST_PORT);
const host = process.env.MMG_TEST_HOST ?? "127.0.0.1";
const skip = !port;

const base = { host, port, database: "t", password: "pw" };
let c: Connections;

before(async () => {
  if (skip) return;
  c = new Connections(
    parseConfig({
      connections: {
        reader: { ...base, user: "u", allow: { select: true }, maxRows: 3 },
        writer: { ...base, user: "u", allow: { select: true, insert: true, update: true, delete: true, ddl: true } },
        insonly: { ...base, user: "u", allow: { select: true, insert: true } },
        dbro: { ...base, user: "ro", allow: { select: true, insert: true } },
      },
    }),
  );
  await c.run("writer", "DROP TABLE IF EXISTS items");
  await c.run("writer", "CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50), big BIGINT, blob_col BLOB)");
});

after(async () => {
  if (skip) return;
  await c.run("writer", "DROP TABLE IF EXISTS items");
  await c.close();
});

test("insert / select / update / delete round trip", { skip }, async () => {
  const ins = await c.run("writer", "INSERT INTO items (name, big) VALUES (?, ?)", ["a'b; DROP TABLE items", "9007199254740993"]);
  assert.equal(ins.affectedRows, 1);
  assert.equal(String(ins.insertId), "1");
  const sel = await c.run("reader", "SELECT id, name, big FROM items WHERE id = ?", [1]);
  assert.deepEqual(sel.rows, [{ id: 1, name: "a'b; DROP TABLE items", big: "9007199254740993" }]);
  assert.equal((await c.run("writer", "UPDATE items SET name = 'x' WHERE id = 1")).affectedRows, 1);
  assert.equal((await c.run("writer", "DELETE FROM items WHERE id = 1")).affectedRows, 1);
  assert.equal((await c.run("reader", "SELECT COUNT(*) AS n FROM items")).rows![0]!.n, 0);
});

test("each operation is denied unless enabled on that connection", { skip }, async () => {
  await assert.rejects(c.run("reader", "INSERT INTO items (name) VALUES ('x')"), /does not allow: insert/);
  await assert.rejects(c.run("reader", "UPDATE items SET name = 'x'"), /does not allow: update/);
  await assert.rejects(c.run("reader", "DELETE FROM items"), /does not allow: delete/);
  await assert.rejects(c.run("reader", "DROP TABLE items"), /does not allow: ddl/);
  await assert.rejects(c.run("insonly", "UPDATE items SET name = 'x'"), /does not allow: update/);
  await assert.rejects(c.run("insonly", "REPLACE INTO items (id, name) VALUES (1, 'x')"), /does not allow: delete/);
  await assert.rejects(c.run("insonly", "INSERT INTO items (id,name) VALUES (1,'x') ON DUPLICATE KEY UPDATE name='y'"), /does not allow: update/);
  await assert.rejects(c.run("insonly", "SELECT 1; DELETE FROM items"), /Multiple statements/);
  assert.equal((await c.run("reader", "SELECT COUNT(*) AS n FROM items")).rows![0]!.n, 0);
});

test("maxRows caps the result and reports truncation; connection stays usable", { skip }, async () => {
  await c.run("writer", "INSERT INTO items (name) VALUES ('1'),('2'),('3'),('4'),('5')");
  const r = await c.run("reader", "SELECT * FROM items ORDER BY id");
  assert.equal(r.rows!.length, 3);
  assert.equal(r.truncated, true);
  const exact = await c.run("reader", "SELECT * FROM items ORDER BY id LIMIT 3");
  assert.equal(exact.rows!.length, 3);
  assert.equal(exact.truncated, false);
  for (let i = 0; i < 5; i++) assert.equal((await c.run("reader", "SELECT COUNT(*) AS n FROM items")).rows![0]!.n, 5);
  await c.run("writer", "DELETE FROM items");
});

test("failed write rolls back and connection is reusable", { skip }, async () => {
  await assert.rejects(c.run("writer", "INSERT INTO items (id, name) VALUES (1,'a'),(1,'b')"), /Duplicate/);
  assert.equal((await c.run("reader", "SELECT COUNT(*) AS n FROM items")).rows![0]!.n, 0);
});

test("database account without privilege still fails even if config allows", { skip }, async () => {
  await assert.rejects(c.run("dbro", "INSERT INTO items (name) VALUES ('x')"), /denied/i);
});

test("binary values are summarized, not dumped", { skip }, async () => {
  await c.run("writer", "INSERT INTO items (name, blob_col) VALUES ('b', REPEAT('A', 1000))");
  const r = await c.run("reader", "SELECT blob_col FROM items");
  assert.match(String(r.rows![0]!.blob_col), /^<binary 1000 bytes/);
  await c.run("writer", "DELETE FROM items");
});

test("backslash escapes parse like the classifier assumes", { skip }, async () => {
  const r = await c.run("reader", "SELECT 'a\\'; b' AS x");
  assert.equal(r.rows![0]!.x, "a'; b");
});

test("unknown connection / missing connection name", { skip }, async () => {
  assert.throws(() => c.get("nope"), /Unknown connection/);
  assert.throws(() => c.resolveName(undefined), /required/);
});
