/**
 * SQL dump writer (structure + data + views, triggers, routines) for the mysql_dump tool.
 * Reads only (SHOW CREATE ..., SELECT) inside one consistent-snapshot, READ ONLY transaction.
 * Output goes to a file, never into the model context.
 */
import { open, lstat, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { escape, escapeId } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import type { Connection as RawConnection } from "mysql2";

export interface DumpOptions {
  database: string;
  /** Base tables/views to dump; all when omitted. */
  tables?: string[];
  structure: boolean;
  data: boolean;
  /** Views, triggers, stored procedures and functions. */
  routines: boolean;
  outputPath: string;
  overwrite: boolean;
  /** Per-table timeout for the data SELECT. */
  timeoutMs: number;
}

export interface DumpResult {
  path: string;
  bytes: number;
  database: string;
  tables: { name: string; rows: number }[];
  views: string[];
  triggers: string[];
  routines: string[];
  elapsedMs: number;
}

const BATCH_ROWS = 200;
const BATCH_BYTES = 512 * 1024;

type Row = Record<string, unknown>;

async function rows(conn: PoolConnection, sql: string, values?: unknown[]): Promise<Row[]> {
  const [r] = await conn.query(sql, values);
  return r as Row[];
}

/** Value of the first column whose name starts with `prefix` (SHOW CREATE columns are named 'Create Table' etc.). */
function createStmt(row: Row | undefined, prefix: string, what: string): string {
  const key = row && Object.keys(row).find((k) => k.startsWith(prefix));
  const v = key ? row![key] : null;
  if (typeof v !== "string" || !v) throw new Error(`No definition returned for ${what} (missing privilege?).`);
  return v;
}

export async function checkOutputPath(path: string, overwrite: boolean): Promise<void> {
  if (!isAbsolute(path)) throw new Error("outputPath must be an absolute path.");
  if (!path.toLowerCase().endsWith(".sql")) throw new Error("outputPath must end with .sql.");
  const dir = await stat(dirname(path)).catch(() => null);
  if (!dir?.isDirectory()) throw new Error(`Directory does not exist: ${dirname(path)}`);
  const existing = await lstat(path).catch(() => null);
  if (existing) {
    if (!overwrite) throw new Error(`File exists: ${path} (set overwrite=true to replace it).`);
    if (!existing.isFile()) throw new Error(`Refusing to overwrite a non-regular file (symlink, directory, ...): ${path}`);
  }
}

async function listObjects(conn: PoolConnection, db: string, only?: string[]) {
  const all = await rows(conn, `SHOW FULL TABLES FROM ${escapeId(db)}`);
  const found = all.map((r) => ({ name: String(Object.values(r)[0]), isView: String(r.Table_type) === "VIEW" }));
  if (!only) return found;
  const names = new Set(found.map((f) => f.name));
  const missing = only.filter((t) => !names.has(t));
  if (missing.length > 0) throw new Error(`Unknown table(s) in '${db}': ${missing.join(", ")}`);
  const wanted = new Set(only);
  return found.filter((f) => wanted.has(f.name));
}

/** Streams `SELECT cols FROM table` as arrays; JSON as raw text, GEOMETRY as raw bytes so they restore losslessly. */
function streamRows(raw: RawConnection, sql: string, timeout: number): AsyncIterable<unknown[]> {
  const q = raw.query({
    sql,
    timeout,
    rowsAsArray: true,
    typeCast: (field: { type: string; string(): string | null; buffer(): Buffer | null }, next: () => unknown) => {
      if (field.type === "JSON") return field.string();
      if (field.type === "GEOMETRY") return field.buffer();
      return next();
    },
  } as never);
  return (q as unknown as { stream(): AsyncIterable<unknown[]> }).stream();
}

/**
 * SQL literal for one cell. The driver can hand back JSON columns already parsed (object/array); `escape` would turn
 * those into `key` = value pairs or lists, i.e. broken SQL and lost data. Serialise them back to JSON text instead.
 */
export function literal(v: unknown): string {
  if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return escape(JSON.stringify(v));
  }
  return escape(v as never);
}

export async function writeDump(conn: PoolConnection, opts: DumpOptions): Promise<DumpResult> {
  const started = Date.now();
  await checkOutputPath(opts.outputPath, opts.overwrite);
  const db = opts.database;
  const objects = await listObjects(conn, db, opts.tables);
  const baseTables = objects.filter((o) => !o.isView);
  const views = objects.filter((o) => o.isView);

  const fh = await open(opts.outputPath, opts.overwrite ? "w" : "wx", 0o600);
  let bytes = 0;
  const w = async (s: string) => {
    bytes += Buffer.byteLength(s);
    await fh.write(s);
  };
  const result: DumpResult = { path: opts.outputPath, bytes: 0, database: db, tables: [], views: [], triggers: [], routines: [], elapsedMs: 0 };

  try {
    await w(
      `-- crispy-mysql-mcp-guard dump of ${escapeId(db)}\n-- ${new Date().toISOString()}\n\n` +
        "/*!40101 SET NAMES utf8mb4 */;\n/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n",
    );

    for (const t of baseTables) {
      const id = `${escapeId(db)}.${escapeId(t.name)}`;
      if (opts.structure) {
        const ddl = createStmt((await rows(conn, `SHOW CREATE TABLE ${id}`))[0], "Create Table", `table ${t.name}`);
        await w(`DROP TABLE IF EXISTS ${escapeId(t.name)};\n${ddl};\n\n`);
      }
      let count = 0;
      if (opts.data) {
        // generated columns cannot be inserted into
        const cols = (await rows(conn, `SHOW COLUMNS FROM ${id}`)).filter((c) => !/GENERATED/i.test(String(c.Extra ?? "")));
        if (cols.length > 0) {
          const names = cols.map((c) => escapeId(String(c.Field)));
          const head = `INSERT INTO ${escapeId(t.name)} (${names.join(", ")}) VALUES\n`;
          let batch: string[] = [];
          let batchBytes = 0;
          const flush = async () => {
            if (batch.length === 0) return;
            await w(`${head}${batch.join(",\n")};\n`);
            batch = [];
            batchBytes = 0;
          };
          for await (const r of streamRows(conn.connection as unknown as RawConnection, `SELECT ${names.join(", ")} FROM ${id}`, opts.timeoutMs)) {
            const tuple = `(${r.map(literal).join(", ")})`;
            batch.push(tuple);
            batchBytes += tuple.length;
            count++;
            if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
          }
          await flush();
          if (count > 0) await w("\n");
        }
      }
      result.tables.push({ name: t.name, rows: count });
    }

    if (opts.routines) {
      for (const v of views) {
        const ddl = createStmt((await rows(conn, `SHOW CREATE VIEW ${escapeId(db)}.${escapeId(v.name)}`))[0], "Create View", `view ${v.name}`);
        await w(`DROP VIEW IF EXISTS ${escapeId(v.name)};\n${ddl};\n\n`);
        result.views.push(v.name);
      }

      // Triggers/routines contain ';' in their bodies.
      const body: string[] = [];
      const wanted = opts.tables ? new Set(opts.tables) : null;
      for (const t of await rows(conn, `SHOW TRIGGERS FROM ${escapeId(db)}`)) {
        const name = String(t.Trigger);
        if (wanted && !wanted.has(String(t.Table))) continue;
        const ddl = createStmt((await rows(conn, `SHOW CREATE TRIGGER ${escapeId(db)}.${escapeId(name)}`))[0], "SQL Original Statement", `trigger ${name}`);
        body.push(`DROP TRIGGER IF EXISTS ${escapeId(name)};;\n${ddl};;\n`);
        result.triggers.push(name);
      }
      if (!opts.tables) {
        const routines = await rows(conn, "SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME", [db]);
        for (const r of routines) {
          const kind = String(r.t) === "FUNCTION" ? "FUNCTION" : "PROCEDURE";
          const name = String(r.n);
          const ddl = createStmt((await rows(conn, `SHOW CREATE ${kind} ${escapeId(db)}.${escapeId(name)}`))[0], "Create ", `${kind.toLowerCase()} ${name}`);
          body.push(`DROP ${kind} IF EXISTS ${escapeId(name)};;\n${ddl};;\n`);
          result.routines.push(`${kind.toLowerCase()} ${name}`);
        }
      }
      if (body.length > 0) await w(`DELIMITER ;;\n${body.join("\n")}DELIMITER ;\n\n`);
    }

    await w(
      "/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n",
    );
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(opts.outputPath).catch(() => {});
    throw e;
  }
  result.bytes = bytes;
  result.elapsedMs = Date.now() - started;
  return result;
}
