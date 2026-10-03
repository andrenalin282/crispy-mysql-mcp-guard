import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, SqlRejected } from "../src/sql.js";

const ops = (sql: string) => classify(sql).ops.slice().sort();
const rejected = (sql: string) => assert.throws(() => classify(sql), SqlRejected, sql);

test("reads", () => {
  assert.deepEqual(ops("SELECT 1"), ["select"]);
  assert.deepEqual(ops("  select * from t where a = 'x;y' ;"), ["select"]);
  assert.deepEqual(ops("(SELECT 1) UNION (SELECT 2)"), ["select"]);
  assert.deepEqual(ops("SHOW TABLES"), ["select"]);
  assert.deepEqual(ops("DESCRIBE t"), ["select"]);
  assert.deepEqual(ops("desc t"), ["select"]);
  assert.deepEqual(ops("EXPLAIN SELECT * FROM t"), ["select"]);
  assert.deepEqual(ops("EXPLAIN FORMAT=JSON SELECT * FROM t"), ["select"]);
  assert.deepEqual(ops("WITH x AS (SELECT 1) SELECT * FROM x"), ["select"]);
  assert.deepEqual(ops("SELECT INSERT('abc', 1, 1, 'x'), REPLACE('a','a','b')"), ["select"]);
  assert.deepEqual(ops("WITH x AS (SELECT REPLACE('a','a','b') r) SELECT r FROM x"), ["select"]);
});

test("writes need their own permission", () => {
  assert.deepEqual(ops("INSERT INTO t VALUES (1)"), ["insert"]);
  assert.deepEqual(ops("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2"), ["insert", "update"]);
  assert.deepEqual(ops("REPLACE INTO t VALUES (1)"), ["delete", "insert"]);
  assert.deepEqual(ops("UPDATE t SET a = 1"), ["update"]);
  assert.deepEqual(ops("DELETE FROM t"), ["delete"]);
  assert.deepEqual(ops("TRUNCATE TABLE t"), ["ddl"]);
  assert.deepEqual(ops("DROP TABLE t"), ["ddl"]);
  assert.deepEqual(ops("ALTER TABLE t ADD c INT"), ["ddl"]);
  assert.deepEqual(ops("CREATE TABLE t (a INT)"), ["ddl"]);
  assert.deepEqual(ops("RENAME TABLE a TO b"), ["ddl"]);
});

test("CTE with DML is not a read", () => {
  assert.deepEqual(ops("WITH x AS (SELECT 1) DELETE FROM t"), ["delete", "select"]);
  assert.deepEqual(ops("WITH x AS (SELECT 1 a) UPDATE t SET b = 1"), ["select", "update"]);
  assert.deepEqual(ops("WITH x AS (SELECT 1 a) INSERT INTO t SELECT a FROM x"), ["insert", "select"]);
});

test("EXPLAIN ANALYZE is classified by the statement it executes", () => {
  assert.deepEqual(ops("EXPLAIN ANALYZE SELECT 1"), ["select"]);
  assert.deepEqual(ops("EXPLAIN ANALYZE DELETE FROM t"), ["delete"]);
  assert.deepEqual(ops("EXPLAIN ANALYZE FORMAT=TREE UPDATE t SET a=1"), ["update"]);
  assert.deepEqual(ops("EXPLAIN FORMAT=TREE ANALYZE DELETE FROM t"), ["delete"]);
  rejected("EXPLAIN ANALYZE");
});

test("multiple statements and tricks are rejected", () => {
  rejected("SELECT 1; DROP TABLE t");
  rejected("SELECT 1;; SELECT 2");
  rejected("SELECT 1 /*! ; DROP TABLE t */");
  rejected("/*!50000 DROP TABLE t */");
  rejected("/*M!100000 DROP TABLE t */");
  rejected("SELECT 'abc");
  rejected("SELECT 1 /* x");
  rejected("");
  rejected("  ; ");
  rejected("-- only a comment");
});

test("comments and strings cannot hide or fake keywords", () => {
  assert.deepEqual(ops("SELECT 1 -- DELETE FROM t"), ["select"]);
  assert.deepEqual(ops("SELECT 1 # DROP TABLE t"), ["select"]);
  assert.deepEqual(ops("SELECT 'DROP TABLE t; --'"), ["select"]);
  assert.deepEqual(ops("SELECT \"a;b\""), ["select"]);
  assert.deepEqual(ops("SELECT `a;b` FROM t"), ["select"]);
  assert.deepEqual(ops("SELECT 'it''s; fine'"), ["select"]);
  assert.deepEqual(ops("SELECT 'it\\'s; fine'"), ["select"]);
  assert.deepEqual(ops("/* c */ DELETE /* c */ FROM t"), ["delete"]);
  assert.deepEqual(ops("SELECT 5--1"), ["select"]);
  // a second statement behind a comment is still a second statement
  rejected("SELECT 1;-- x\nDELETE FROM t");
});

test("unsupported statements are rejected", () => {
  for (const s of [
    "GRANT ALL ON *.* TO x",
    "SET GLOBAL read_only = 0",
    "CALL p()",
    "LOAD DATA INFILE '/etc/passwd' INTO TABLE t",
    "USE other",
    "KILL 1",
    "FLUSH PRIVILEGES",
    "LOCK TABLES t WRITE",
    "PREPARE s FROM 'DROP TABLE t'",
    "DO SLEEP(1)",
    "HANDLER t OPEN",
    "CREATE USER x",
    "DROP USER x",
    "ALTER USER x IDENTIFIED BY 'y'",
    "CREATE ROLE r",
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "SELECT 1 INTO DUMPFILE '/tmp/x'",
    "SELECT LOAD_FILE('/etc/passwd')",
  ]) {
    rejected(s);
  }
});
