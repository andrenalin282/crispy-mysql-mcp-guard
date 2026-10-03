import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, parseArgs, configFromFlags, resolveConfig } from "../src/config.js";

test("defaults: read only", () => {
  const c = parseConfig({ connections: { a: { user: "u" } } }, {});
  assert.deepEqual(c.a!.allow, { select: true, insert: false, update: false, delete: false, ddl: false });
  assert.equal(c.a!.host, "localhost");
  assert.equal(c.a!.port, 3306);
  assert.equal(c.a!.maxRows, 1000);
});

test("each operation is enabled separately", () => {
  const c = parseConfig({ connections: { a: { user: "u", allow: { insert: true, delete: true } } } }, {});
  assert.deepEqual(c.a!.allow, { select: true, insert: true, update: false, delete: true, ddl: false });
});

test("${VAR} references are expanded, missing variable is an error", () => {
  const c = parseConfig({ connections: { a: { user: "u", password: "${PW}" } } }, { PW: "secret" });
  assert.equal(c.a!.password, "secret");
  assert.throws(() => parseConfig({ connections: { a: { user: "u", password: "${NOPE}" } } }, {}), /NOPE/);
});

test("literal values are not touched by the process environment", () => {
  const c = parseConfig({ connections: { a: { user: "u", password: "p", host: "h" } } }, { MYSQL_HOST: "evil", MYSQL_PASSWORD: "evil" });
  assert.equal(c.a!.host, "h");
  assert.equal(c.a!.password, "p");
});

test("invalid config is rejected", () => {
  assert.throws(() => parseConfig({}, {}), /Invalid config/);
  assert.throws(() => parseConfig({ connections: {} }, {}), /empty/);
  assert.throws(() => parseConfig({ connections: { a: {} } }, {}), /user/);
  assert.throws(() => parseConfig({ connections: { a: { user: "u", allow: { drop: true } } } }, {}), /Invalid config/);
  assert.throws(() => parseConfig({ connections: { a: { user: "u", typo: 1 } } }, {}), /Invalid config/);
  assert.throws(() => parseConfig({ connections: { "bad name": { user: "u" } } }, {}), /connection names/);
});

test("single connection from flags", () => {
  const c = configFromFlags({ name: "x", host: "h", user: "u", password: "p", database: "d", allow: "select, insert", "max-rows": "5" }, {});
  assert.deepEqual(c.x!.allow, { select: true, insert: true, update: false, delete: false, ddl: false });
  assert.equal(c.x!.maxRows, 5);
  // --allow without select really means no select
  assert.equal(configFromFlags({ user: "u", allow: "insert" }, {}).default!.allow.select, false);
  assert.throws(() => configFromFlags({ user: "u", allow: "drop" }, {}), /unknown operation/);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--config", "a.json"]), { config: "a.json", flags: {} });
  assert.deepEqual(parseArgs(["--host=h", "--user", "u"]).flags, { host: "h", user: "u" });
  assert.throws(() => parseArgs(["--nope", "1"]), /Unknown option/);
  assert.throws(() => parseArgs(["--host"]), /Missing value/);
  assert.throws(() => parseArgs(["host"]), /Unexpected/);
});

test("resolveConfig: --config relative to cwd, default ./mysql-mcp.json, error when nothing found", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmg-"));
  assert.throws(() => resolveConfig([], {}, dir), /No configuration found/);
  writeFileSync(join(dir, "mysql-mcp.json"), JSON.stringify({ connections: { a: { user: "u" } } }));
  assert.deepEqual(Object.keys(resolveConfig([], {}, dir)), ["a"]);
  writeFileSync(join(dir, "other.json"), JSON.stringify({ connections: { b: { user: "u" } } }));
  assert.deepEqual(Object.keys(resolveConfig(["--config", "other.json"], {}, dir)), ["b"]);
  assert.deepEqual(Object.keys(resolveConfig([], { MYSQL_MCP_GUARD_CONFIG: "other.json" }, dir)), ["b"]);
  writeFileSync(join(dir, "bad.json"), "{nope");
  assert.throws(() => resolveConfig(["--config", "bad.json"], {}, dir), /not valid JSON/);
});
