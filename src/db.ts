import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import type { Connection as RawConnection } from "mysql2";
import type { Config, ConnectionConfig } from "./config.js";
import { classify, type Op } from "./sql.js";
import { writeDump, type DumpResult } from "./dump.js";

export interface QueryResult {
  connection: string;
  operations: Op[];
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  affectedRows?: number;
  insertId?: string | number;
  warningStatus?: number;
  elapsedMs: number;
}

const BLOB_PREVIEW = 256;

function normalizeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) {
    const head = v.subarray(0, BLOB_PREVIEW).toString("base64");
    return v.length > BLOB_PREVIEW ? `<binary ${v.length} bytes, base64 head: ${head}>` : `<binary ${v.length} bytes, base64: ${head}>`;
  }
  return v;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

export function allowedOps(c: ConnectionConfig): Op[] {
  return (Object.entries(c.allow) as [Op, boolean][]).filter(([, on]) => on).map(([op]) => op);
}

function sslOption(ssl: ConnectionConfig["ssl"]): mysql.PoolOptions["ssl"] {
  if (ssl === false) return undefined;
  if (ssl === "skip-verify") return { rejectUnauthorized: false };
  return {};
}

/** Streams a result set and stops (destroying the connection) once maxRows is exceeded. */
function streamSelect(
  raw: RawConnection,
  opts: { sql: string; values?: unknown[]; timeout: number },
  maxRows: number,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; destroyed: boolean }> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let settled = false;
    const q = raw.query(opts);
    q.on("fields", (f: { name: string }[]) => {
      columns = f.map((x) => x.name);
    });
    q.on("result", (row: Record<string, unknown>) => {
      if (settled) return;
      if (rows.length >= maxRows) {
        settled = true;
        raw.destroy();
        resolve({ columns, rows, truncated: true, destroyed: true });
        return;
      }
      rows.push(normalizeRow(row));
    });
    q.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    q.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ columns, rows, truncated: false, destroyed: false });
    });
  });
}

export class Connections {
  private pools = new Map<string, Pool>();

  constructor(private config: Config) {}

  names(): string[] {
    return Object.keys(this.config);
  }

  get(name: string): ConnectionConfig {
    const c = this.config[name];
    if (!c) throw new Error(`Unknown connection '${name}'. Available: ${this.names().join(", ")}`);
    return c;
  }

  /** Name may be omitted when exactly one connection is configured. */
  resolveName(name: string | undefined): string {
    if (name) return name;
    const names = this.names();
    if (names.length === 1) return names[0]!;
    throw new Error(`'connection' is required. Available: ${names.join(", ")}`);
  }

  private pool(name: string): Pool {
    let p = this.pools.get(name);
    if (!p) {
      const c = this.get(name);
      p = mysql.createPool({
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        database: c.database,
        ssl: sslOption(c.ssl),
        charset: "utf8mb4",
        connectTimeout: 10000,
        connectionLimit: 2,
        waitForConnections: true,
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: false,
        dateStrings: true,
      });
      this.pools.set(name, p);
    }
    return p;
  }

  async run(connection: string, sql: string, params?: unknown[]): Promise<QueryResult> {
    const cfg = this.get(connection);
    const { ops, sql: statement } = classify(sql);
    const denied = ops.filter((op) => !cfg.allow[op]);
    if (denied.length > 0) {
      throw new Error(
        `Connection '${connection}' does not allow: ${denied.join(", ")}. Enabled operations: ${allowedOps(cfg).join(", ") || "none"}.`,
      );
    }

    const started = Date.now();
    const conn: PoolConnection = await this.pool(connection).getConnection();
    let destroyed = false;
    try {
      // NO_BACKSLASH_ESCAPES would change how string literals parse; the classifier assumes the default.
      await conn.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
      const readOnly = ops.length === 1 && ops[0] === "select";
      await conn.query(readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION");
      const values = params && params.length > 0 ? params : undefined;
      try {
        if (readOnly) {
          const r = await streamSelect(conn.connection as unknown as RawConnection, { sql: statement, values, timeout: cfg.timeoutMs }, cfg.maxRows);
          destroyed = r.destroyed;
          if (!destroyed) await conn.query("ROLLBACK");
          return {
            connection,
            operations: ops,
            columns: r.columns,
            rows: r.rows,
            rowCount: r.rows.length,
            truncated: r.truncated,
            elapsedMs: Date.now() - started,
          };
        }
        const [res] = await conn.query({ sql: statement, values, timeout: cfg.timeoutMs });
        await conn.query("COMMIT");
        const header = res as { affectedRows?: number; insertId?: number | string; warningStatus?: number };
        return {
          connection,
          operations: ops,
          affectedRows: header.affectedRows,
          insertId: header.insertId,
          warningStatus: header.warningStatus,
          elapsedMs: Date.now() - started,
        };
      } catch (e) {
        if (!destroyed) {
          try {
            await conn.query("ROLLBACK");
          } catch {
            destroyed = true;
          }
        }
        throw e;
      }
    } finally {
      if (destroyed) conn.destroy();
      else conn.release();
    }
  }

  /** Writes a SQL dump to a file. Needs the select permission; runs in a consistent-snapshot READ ONLY transaction. */
  async dump(
    connection: string,
    o: { database?: string; tables?: string[]; structure: boolean; data: boolean; routines: boolean; outputPath: string; overwrite: boolean },
  ): Promise<DumpResult> {
    const cfg = this.get(connection);
    if (!cfg.allow.select) {
      throw new Error(`Connection '${connection}' does not allow: select. Enabled operations: ${allowedOps(cfg).join(", ") || "none"}.`);
    }
    const database = o.database ?? cfg.database;
    if (!database) throw new Error("'database' is required: the connection has no default database.");
    if (!o.structure && !o.data && !o.routines) throw new Error("Nothing to dump: structure, data and routines are all false.");
    const conn: PoolConnection = await this.pool(connection).getConnection();
    let destroyed = false;
    try {
      await conn.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      try {
        return await writeDump(conn, { ...o, database, timeoutMs: cfg.timeoutMs });
      } catch (e) {
        // a half-read result stream leaves the connection unusable
        destroyed = true;
        throw e;
      }
    } finally {
      if (destroyed) conn.destroy();
      else {
        await conn.query("ROLLBACK").catch(() => {});
        conn.release();
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pools.values()].map((p) => p.end()));
    this.pools.clear();
  }
}
