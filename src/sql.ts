/**
 * SQL classification. Every statement is mapped to the operations it needs
 * (select/insert/update/delete/ddl) so each connection can allow them separately.
 * Anything not understood is rejected (fail-closed).
 */

export type Op = "select" | "insert" | "update" | "delete" | "ddl";

export class SqlRejected extends Error {}

/** Removes comments, blanks string literals and backtick identifiers. */
export function strip(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (c === "/" && d === "*") {
      const third = sql[i + 2];
      if (third === "!" || (third === "M" && sql[i + 3] === "!")) {
        throw new SqlRejected("Executable comments (/*! ... */) are not allowed.");
      }
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new SqlRejected("Unterminated comment.");
      out += " ";
      i = end + 2;
      continue;
    }
    if (c === "#" || (c === "-" && d === "-" && (i + 2 >= n || /\s/.test(sql[i + 2]!)))) {
      const nl = sql.indexOf("\n", i);
      out += " ";
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new SqlRejected("Unterminated string or identifier.");
        if (c !== "`" && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += c === "`" ? "`x`" : "''";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const FORBIDDEN_ANYWHERE: [RegExp, string][] = [
  [/\bINTO\s+(OUTFILE|DUMPFILE)\b/, "INTO OUTFILE/DUMPFILE"],
  [/\bLOAD_FILE\s*\(/, "LOAD_FILE()"],
];

function classifyUpper(up: string): Op[] {
  const first = /^[A-Z_]+/.exec(up)?.[0];
  if (!first) throw new SqlRejected("Could not determine statement type.");

  switch (first) {
    case "SELECT":
    case "SHOW":
      return ["select"];

    case "WITH": {
      const ops = new Set<Op>(["select"]);
      if (/\bINSERT\b(?!\s*\()/.test(up)) ops.add("insert");
      if (/\bREPLACE\b(?!\s*\()/.test(up)) {
        ops.add("insert");
        ops.add("delete");
      }
      if (/\bUPDATE\b/.test(up)) ops.add("update");
      if (/\bDELETE\b/.test(up)) ops.add("delete");
      return [...ops];
    }

    case "EXPLAIN":
    case "DESCRIBE":
    case "DESC": {
      const m = /^(?:EXPLAIN|DESCRIBE|DESC) (?:FORMAT ?= ?\w+ )?(?:ANALYZE|ANALYSE) (?:FORMAT ?= ?\w+ )?(.+)$/.exec(up);
      if (m) return classifyUpper(m[1]!.replace(/^\(+\s*/, ""));
      // EXPLAIN ANALYZE executes the statement; anything we cannot parse is refused.
      if (/\bANALY[ZS]E\b/.test(up)) throw new SqlRejected("Unsupported EXPLAIN ANALYZE form.");
      return ["select"];
    }

    case "INSERT":
      return /\bON DUPLICATE KEY UPDATE\b/.test(up) ? ["insert", "update"] : ["insert"];
    case "REPLACE":
      return ["insert", "delete"];
    case "UPDATE":
      return ["update"];
    case "DELETE":
      return ["delete"];

    case "CREATE":
    case "ALTER":
    case "DROP":
    case "TRUNCATE":
    case "RENAME": {
      if (/^[A-Z]+ (?:OR REPLACE )?(?:USER|ROLE|SERVER|RESOURCE GROUP)\b/.test(up)) {
        throw new SqlRejected(`${first} USER/ROLE/SERVER statements are not supported.`);
      }
      return ["ddl"];
    }

    default:
      throw new SqlRejected(
        `Statement type '${first}' is not supported (allowed: SELECT, SHOW, DESCRIBE, EXPLAIN, INSERT, REPLACE, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, RENAME, WITH).`,
      );
  }
}

/** Returns the operations a single SQL statement needs. Throws SqlRejected otherwise. */
export function classify(sql: string): { ops: Op[]; sql: string } {
  const cleaned = strip(sql).trim();
  // one trailing semicolon is fine, anything after it is a second statement
  const body = cleaned.replace(/;\s*$/, "").trim();
  if (!body) throw new SqlRejected("Empty statement.");
  if (body.includes(";")) throw new SqlRejected("Multiple statements are not allowed.");

  const up = body.toUpperCase().replace(/\s+/g, " ").replace(/^[(\s]+/, "");
  for (const [re, label] of FORBIDDEN_ANYWHERE) {
    if (re.test(up)) throw new SqlRejected(`${label} is not allowed.`);
  }
  const ops = classifyUpper(up);
  return { ops, sql: sql.trim() };
}
