import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import mysql from "mysql2";
import { z } from "zod";
import { allowedOps, type Connections } from "./db.js";

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function fail(e: unknown) {
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
}

export function createServer(conns: Connections, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "mysql-mcp-guard", version });

  const connection = z
    .string()
    .optional()
    .describe("Connection name from mysql_list_connections. Optional when only one connection is configured.");

  server.registerTool(
    "mysql_list_connections",
    {
      description:
        "List configured MySQL connections with host, database and which operations (select/insert/update/delete/ddl) each one allows. Never returns passwords.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        conns.names().map((name) => {
          const c = conns.get(name);
          return {
            name,
            host: c.host,
            port: c.port,
            database: c.database ?? null,
            allow: allowedOps(c),
            maxRows: c.maxRows,
            timeoutMs: c.timeoutMs,
          };
        }),
      ),
  );

  server.registerTool(
    "mysql_query",
    {
      description:
        "Run ONE SQL statement on a connection. Needs the matching permission on that connection: SELECT/SHOW/DESCRIBE/EXPLAIN = select, INSERT = insert, REPLACE = insert+delete, UPDATE = update, DELETE = delete, CREATE/ALTER/DROP/TRUNCATE/RENAME = ddl. Reads run in a READ ONLY transaction; writes run in a transaction that is committed on success. Use '?' placeholders with params. Result sets are capped at the connection's maxRows (truncated=true when cut off).",
      inputSchema: {
        connection,
        sql: z.string().min(1).describe("A single SQL statement."),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe("Values for '?' placeholders."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ connection: name, sql, params }) => {
      try {
        return text(await conns.run(conns.resolveName(name), sql, params));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "mysql_schema",
    {
      description:
        "Inspect the schema. Without 'table': lists tables (name, type, engine, approx. rows) of the database. With 'table': columns and indexes. Needs the select permission.",
      inputSchema: {
        connection,
        database: z.string().optional().describe("Schema name; defaults to the connection's database."),
        table: z.string().optional().describe("Table to describe."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ connection: name, database, table }) => {
      try {
        const conn = conns.resolveName(name);
        if (!table) {
          const r = await conns.run(
            conn,
            "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY TABLE_NAME",
            [database ?? null],
          );
          return text(r);
        }
        const target = (database ? `${mysql.escapeId(database)}.` : "") + mysql.escapeId(table);
        const columns = await conns.run(conn, `SHOW FULL COLUMNS FROM ${target}`);
        const indexes = await conns.run(conn, `SHOW INDEX FROM ${target}`);
        return text({ connection: conn, table, columns: columns.rows, indexes: indexes.rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
