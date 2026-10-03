import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const OPS = ["select", "insert", "update", "delete", "ddl"] as const;

const AllowSchema = z
  .object({
    select: z.boolean().default(true),
    insert: z.boolean().default(false),
    update: z.boolean().default(false),
    delete: z.boolean().default(false),
    ddl: z.boolean().default(false),
  })
  .strict();

const ConnectionSchema = z
  .object({
    host: z.string().default("localhost"),
    port: z.number().int().min(1).max(65535).default(3306),
    user: z.string().min(1),
    password: z.string().default(""),
    database: z.string().optional(),
    ssl: z.union([z.boolean(), z.literal("skip-verify")]).default(false),
    allow: AllowSchema.default({}),
    maxRows: z.number().int().min(1).max(100000).default(1000),
    timeoutMs: z.number().int().min(100).max(600000).default(30000),
  })
  .strict();

const FileSchema = z
  .object({
    connections: z.record(z.string().regex(/^[A-Za-z0-9_.-]+$/, "connection names may only use A-Z a-z 0-9 _ . -"), ConnectionSchema),
  })
  .strict();

export type Allow = z.infer<typeof AllowSchema>;
export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type Config = Record<string, ConnectionConfig>;

export const OPERATIONS = OPS;

/** Replaces ${VAR} references with environment values. Unknown variable = error. */
function expandEnv(value: string, where: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`${where}: environment variable ${name} is not set`);
    return v;
  });
}

function expandConnection(name: string, c: ConnectionConfig, env: NodeJS.ProcessEnv): ConnectionConfig {
  const w = (f: string) => `connection '${name}' ${f}`;
  return {
    ...c,
    host: expandEnv(c.host, w("host"), env),
    user: expandEnv(c.user, w("user"), env),
    password: expandEnv(c.password, w("password"), env),
    database: c.database === undefined ? undefined : expandEnv(c.database, w("database"), env),
  };
}

export function parseConfig(json: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${msg}`);
  }
  const out: Config = {};
  for (const [name, c] of Object.entries(parsed.data.connections)) out[name] = expandConnection(name, c, env);
  if (Object.keys(out).length === 0) throw new Error("Invalid config: 'connections' is empty");
  return out;
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read config file ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(json, env);
}

/** Command-line flags; they never read process environment, so project .env files cannot interfere. */
export interface CliArgs {
  config?: string;
  flags: Record<string, string>;
}

const FLAG_NAMES = new Set(["name", "host", "port", "user", "password", "database", "ssl", "allow", "max-rows", "timeout-ms"]);

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    let key = a.slice(2);
    let val: string | undefined;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      val = argv[++i];
    }
    if (val === undefined) throw new Error(`Missing value for --${key}`);
    if (key === "config") config = val;
    else if (FLAG_NAMES.has(key)) flags[key] = val;
    else throw new Error(`Unknown option --${key}`);
  }
  return { config, flags };
}

function num(flags: Record<string, string>, key: string): number | undefined {
  if (flags[key] === undefined) return undefined;
  const n = Number(flags[key]);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

/** Builds a single connection from flags: --name x --host h --user u --password p --database d --allow select,insert */
export function configFromFlags(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Config {
  const allow: Record<string, boolean> = {};
  if (flags.allow !== undefined) {
    for (const op of OPS) allow[op] = false;
    for (const part of flags.allow.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (!(OPS as readonly string[]).includes(part)) throw new Error(`--allow: unknown operation '${part}' (use ${OPS.join(", ")})`);
      allow[part] = true;
    }
  }
  const ssl = flags.ssl === undefined ? undefined : flags.ssl === "skip-verify" ? "skip-verify" : flags.ssl === "true";
  const conn = {
    host: flags.host,
    port: num(flags, "port"),
    user: flags.user,
    password: flags.password,
    database: flags.database,
    ssl,
    allow: flags.allow === undefined ? undefined : allow,
    maxRows: num(flags, "max-rows"),
    timeoutMs: num(flags, "timeout-ms"),
  };
  const clean = Object.fromEntries(Object.entries(conn).filter(([, v]) => v !== undefined));
  return parseConfig({ connections: { [flags.name ?? "default"]: clean } }, env);
}

/** Order: --config, single-connection flags, MYSQL_MCP_GUARD_CONFIG, ./mysql-mcp.json, ~/.config/crispy-mysql-mcp-guard/config.json */
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const args = parseArgs(argv);
  if (args.config) return loadConfigFile(resolve(cwd, args.config), env);
  if (Object.keys(args.flags).length > 0) return configFromFlags(args.flags, env);
  if (env.MYSQL_MCP_GUARD_CONFIG) return loadConfigFile(resolve(cwd, env.MYSQL_MCP_GUARD_CONFIG), env);
  for (const p of [join(cwd, "mysql-mcp.json"), join(homedir(), ".config", "crispy-mysql-mcp-guard", "config.json")]) {
    if (existsSync(p)) return loadConfigFile(p, env);
  }
  throw new Error(
    "No configuration found. Pass --config <file>, single-connection flags (--host --user --password --database --allow ...), or create ./mysql-mcp.json.",
  );
}
