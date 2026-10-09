# crispy-mysql-mcp-guard

A [Model Context Protocol](https://modelcontextprotocol.io) server for MySQL (and MariaDB) where **every connection decides separately which operations it allows**: `select`, `insert`, `update`, `delete` and `ddl`.

Default is read only. Anything else has to be switched on, per connection, in plain JSON.

- One server, any number of connections, each with its own permissions.
- Reads run in a `READ ONLY` transaction, so the database itself refuses writes on the read path.
- Exactly one statement per call. Multi-statements, executable comments (`/*! ... */`), `INTO OUTFILE`, `LOAD_FILE()`, `LOAD DATA`, `GRANT`, `SET`, `CALL`, `USE` and user/role management are rejected.
- Result sets are capped (`maxRows`, default 1000) and report `truncated`. Large results are streamed and cut off, not loaded into memory first.
- No password ever leaves the server: `mysql_list_connections` shows host, database and permissions only.
- Configuration is JSON (command-line flags or a file). The server does **not** read `MYSQL_*` environment variables, so a project `.env` cannot change which database you talk to.

## Quick start

No npm release yet; run it straight from GitHub (needs Node 20+):

```bash
npx -y github:andrenalin282/crispy-mysql-mcp-guard --help
```

Pin a release tag for reproducible installs (`main` can move): `npx -y github:andrenalin282/crispy-mysql-mcp-guard#v0.2.0 --help`.

### Claude Code / any `.mcp.json`

One connection, configured inline, same shape as most MCP servers:

```json
{
  "mcpServers": {
    "mysql-shop": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "github:andrenalin282/crispy-mysql-mcp-guard",
        "--name", "shop",
        "--host", "localhost",
        "--port", "3306",
        "--user", "shop_user",
        "--password", "secret",
        "--database", "shop",
        "--allow", "select,insert,update"
      ]
    }
  }
}
```

`--allow` takes any of `select,insert,update,delete,ddl`. Leave it out for read only.

Several connections, one config file (keeps passwords out of `.mcp.json`):

```json
{
  "mcpServers": {
    "mysql": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:andrenalin282/crispy-mysql-mcp-guard", "--config", "/home/me/.config/crispy-mysql-mcp-guard/config.json"]
    }
  }
}
```

```json
{
  "connections": {
    "shop-live": {
      "host": "db.example.com",
      "user": "reader",
      "password": "${SHOP_LIVE_PASSWORD}",
      "database": "shop",
      "ssl": true,
      "allow": { "select": true }
    },
    "shop-dev": {
      "host": "localhost",
      "user": "root",
      "password": "dev",
      "database": "shop_dev",
      "allow": { "select": true, "insert": true, "update": true, "delete": true, "ddl": false },
      "maxRows": 500,
      "timeoutMs": 15000
    }
  }
}
```

The agent then picks a connection per call: `mysql_query` with `"connection": "shop-dev"`. With a single connection the name can be omitted.

A full example is in [`mysql-mcp.example.json`](mysql-mcp.example.json).

### Where the config is read from

First match wins:

1. `--config <file>` (relative paths are resolved against the working directory)
2. single-connection flags (`--host`, `--user`, ...)
3. `MYSQL_MCP_GUARD_CONFIG` (path to a config file)
4. `./mysql-mcp.json`
5. `~/.config/crispy-mysql-mcp-guard/config.json`

## Connection options

| Option | Default | Description |
|---|---|---|
| `host` | `localhost` | |
| `port` | `3306` | |
| `user` | required | |
| `password` | `""` | Literal, or `${VAR}` to read it from an environment variable (error if unset). |
| `database` | none | Default schema. |
| `ssl` | `false` | `true` verifies the server certificate, `"skip-verify"` encrypts without verifying. |
| `allow.select` | `true` | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `WITH ... SELECT` |
| `allow.insert` | `false` | `INSERT` |
| `allow.update` | `false` | `UPDATE`, and the `ON DUPLICATE KEY UPDATE` part of an `INSERT` |
| `allow.delete` | `false` | `DELETE` |
| `allow.ddl` | `false` | `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME` |
| `maxRows` | `1000` | Maximum rows returned per query (1 to 100000). |
| `timeoutMs` | `30000` | Query timeout. |

Command-line flags for a single connection: `--name --host --port --user --password --database --ssl --allow --max-rows --timeout-ms`. Unknown options, unknown operations and typos in the JSON are errors, not ignored.

### Which statement needs which permission

| Statement | Needs |
|---|---|
| `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | `select` |
| `INSERT` | `insert` |
| `INSERT ... ON DUPLICATE KEY UPDATE` | `insert` + `update` |
| `REPLACE` (deletes a conflicting row) | `insert` + `delete` |
| `UPDATE` | `update` |
| `DELETE` | `delete` |
| `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME` | `ddl` |
| `WITH ... DELETE/UPDATE/INSERT` | `select` + the write permission |
| `EXPLAIN ANALYZE <stmt>` | whatever `<stmt>` needs (it executes it) |
| everything else | rejected |

## Tools

| Tool | What it does |
|---|---|
| `mysql_list_connections` | Connections with host, database, allowed operations, limits. No passwords. |
| `mysql_query` | Runs one statement (`connection`, `sql`, optional `params` for `?` placeholders). Returns rows, `affectedRows`, `insertId`, `truncated`, `elapsedMs`. |
| `mysql_schema` | Lists tables, or with `table` shows columns and indexes. Needs `select`. |
| `mysql_dump` | Writes a SQL dump to a `.sql` file and returns path, size and row counts (not the content). Needs `select` only. See below. |

### `mysql_dump`

Parameters: `outputPath` (absolute, must end in `.sql`, parent directory must exist), optional `connection`, `database` (default: the connection's), `tables` (default: all), `structure` / `data` / `routines` (all default `true`), `overwrite` (default `false`).

- Output: `DROP TABLE IF EXISTS` + `CREATE TABLE`, batched multi-row `INSERT`s, and with `routines` also views, triggers and stored procedures/functions (routines only when `tables` is not given). Triggers and routines use `DELIMITER ;;`, so restore with the `mysql`/`mariadb` client, not by pasting into a single-statement tool.
- Consistent: one `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` for the whole dump. Generated columns are skipped on insert; JSON, binary and geometry values are written losslessly.
- Not capped by `maxRows` (a dump must be complete). Each table's read is limited by the connection's `timeoutMs`; raise it for big tables.
- The file is created with mode `600`, never overwrites without `overwrite: true`, and refuses symlinks and other non-regular files. A failed dump deletes its partial file. The server writes the file as the user running it, so the model chooses where on that machine; keep `select` off connections where that is not acceptable.
- Restore: `mysql -h HOST -u USER -p DATABASE < dump.sql`.

Writes run in a transaction that is committed on success and rolled back on error. DDL commits implicitly in MySQL, as always. `BIGINT` values beyond 2^53 are returned as strings. Binary columns are summarized instead of dumped.

## Security model, honestly

This is a guard rail for an AI agent, not a security boundary.

- **Use a database account with the least privileges you need.** The `allow` flags are checked by the server before the statement is sent; the database account is the real limit. A connection with `allow: { select: true }` and a `SELECT`-only account cannot be talked into anything else.
- The statement classifier is deliberately strict and refuses what it does not understand. It is not a full SQL parser, so a read can still call a stored function that writes; the `READ ONLY` transaction makes the server reject that on the read path.
- `CALL` is not supported at all, because a stored procedure can do anything its definer can.
- Passwords given as `--password` are visible in the process list and in `.mcp.json`. Prefer a config file with mode `600` and `${VAR}` references for anything shared.
- There is no `WHERE` check: `DELETE FROM t` is allowed if `delete` is on. Give the agent `delete` only where that is acceptable.

## Development

```bash
npm install
npm run typecheck
npm test
```

Unit tests (SQL classifier, config) run anywhere. Integration and end-to-end tests need a MySQL or MariaDB server with a database `t`, an account `u` (all privileges on `t`) and an account `ro` (`SELECT` only), both with password `pw`:

```bash
MMG_TEST_PORT=3306 MMG_TEST_HOST=127.0.0.1 npm test
```

Without `MMG_TEST_PORT` those tests are skipped.

Compatibility: tested against MariaDB 10.11 and MySQL 8.4.

## License

MIT
