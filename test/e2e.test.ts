// End-to-end over stdio, the way an MCP client starts the server. Skipped without MMG_TEST_PORT (see db.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = process.env.MMG_TEST_PORT;
const skip = !port;

async function withClient(args: string[], fn: (c: Client) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", ...args],
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

const body = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

test("single connection from flags: tools, read ok, write denied", { skip }, async () => {
  await withClient(
    ["--name", "t", "--host", "127.0.0.1", "--port", port!, "--user", "u", "--password", "pw", "--database", "t", "--allow", "select"],
    async (c) => {
      const tools = (await c.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, ["mysql_dump", "mysql_list_connections", "mysql_query", "mysql_schema"]);

      const list = JSON.parse(body(await c.callTool({ name: "mysql_list_connections", arguments: {} })));
      assert.equal(list[0].name, "t");
      assert.deepEqual(list[0].allow, ["select"]);
      assert.ok(!JSON.stringify(list).includes("pw"));

      const ok = await c.callTool({ name: "mysql_query", arguments: { sql: "SELECT ? AS v", params: [42] } });
      assert.equal(isError(ok), false);
      assert.equal(JSON.parse(body(ok)).rows[0].v, 42);

      const denied = await c.callTool({ name: "mysql_query", arguments: { sql: "DELETE FROM x" } });
      assert.equal(isError(denied), true);
      assert.match(body(denied), /does not allow: delete/);

      const schema = await c.callTool({ name: "mysql_schema", arguments: {} });
      assert.equal(isError(schema), false);
    },
  );
});

test("config file with two connections: name required, permissions per connection", { skip }, async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mmg-e2e-"));
  const file = join(dir, "c.json");
  const base = { host: "127.0.0.1", port: Number(port), user: "u", password: "${MMG_E2E_PW}", database: "t" };
  writeFileSync(file, JSON.stringify({ connections: { ro: { ...base, allow: { select: true } }, rw: { ...base, allow: { select: true, insert: true, ddl: true } } } }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "--config", file],
    env: { PATH: process.env.PATH ?? "", MMG_E2E_PW: "pw" },
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  try {
    const noName = await c.callTool({ name: "mysql_query", arguments: { sql: "SELECT 1" } });
    assert.equal(isError(noName), true);
    assert.match(body(noName), /'connection' is required/);

    const create = await c.callTool({ name: "mysql_query", arguments: { connection: "rw", sql: "CREATE TABLE IF NOT EXISTS e2e (a INT)" } });
    assert.equal(isError(create), false, body(create));
    const insRo = await c.callTool({ name: "mysql_query", arguments: { connection: "ro", sql: "INSERT INTO e2e VALUES (1)" } });
    assert.equal(isError(insRo), true);
    const insRw = await c.callTool({ name: "mysql_query", arguments: { connection: "rw", sql: "INSERT INTO e2e VALUES (1)" } });
    assert.equal(isError(insRw), false, body(insRw));
    const upd = await c.callTool({ name: "mysql_query", arguments: { connection: "rw", sql: "UPDATE e2e SET a = 2" } });
    assert.equal(isError(upd), true);
    const schema = await c.callTool({ name: "mysql_schema", arguments: { connection: "ro", table: "e2e" } });
    assert.equal(isError(schema), false, body(schema));
    assert.equal(JSON.parse(body(schema)).columns[0].Field, "a");
    await c.callTool({ name: "mysql_query", arguments: { connection: "rw", sql: "DROP TABLE e2e" } });
  } finally {
    await c.close();
  }
});

test("bad config: process exits with a message on stderr", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", "--config", "/nonexistent.json"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cannot read config file/);
  assert.equal(r.stdout, "");
});
