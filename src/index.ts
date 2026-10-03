#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { Connections } from "./db.js";
import { createServer } from "./server.js";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      [
        "crispy-mysql-mcp-guard - MySQL MCP server with per-connection permissions",
        "",
        "  --config <file>        JSON config with one or more connections",
        "  single connection:     --name <n> --host <h> --port <p> --user <u> --password <pw>",
        "                         --database <db> --allow select,insert,update,delete,ddl",
        "                         [--ssl true|skip-verify] [--max-rows N] [--timeout-ms N]",
        "",
        "Without options: MYSQL_MCP_GUARD_CONFIG, ./mysql-mcp.json, ~/.config/crispy-mysql-mcp-guard/config.json",
        "",
      ].join("\n"),
    );
    return;
  }
  const conns = new Connections(resolveConfig(argv));
  const server = createServer(conns);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    void conns.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => {
  // stdout is the MCP channel; diagnostics go to stderr only
  process.stderr.write(`crispy-mysql-mcp-guard: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
