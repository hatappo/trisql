// bisql の docs/07-rendering-examples.md をゴールデンテストとして移植したもの。
// プレースホルダは `?` ではなく `$n`。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL, DEFAULT, LIKE_CONTAINS, parse, render, TrisqlError } from "../src/index.ts";

const run = (sql: string, params: Record<string, unknown>) => render(parse(sql), params);

describe("variables", () => {
  it("1-1 bind", () => {
    assert.deepEqual(run("SELECT * FROM users WHERE id = /*$id*/1", { id: 42 }), {
      sql: "SELECT * FROM users WHERE id = $1",
      params: [42],
    });
  });

  it("1-2 literal", () => {
    assert.deepEqual(run("SELECT * FROM users WHERE type = /*^type*/'A'", { type: "BOOK" }), {
      sql: "SELECT * FROM users WHERE type = 'BOOK'",
      params: [],
    });
  });

  it("1-2b literal doubles single quotes", () => {
    assert.equal(run("SELECT /*^v*/'A'", { v: "it's" }).sql, "SELECT 'it''s'");
  });

  it("1-3 raw", () => {
    assert.deepEqual(run("SELECT * FROM users ORDER BY /*!orderBy*/column_name", { orderBy: "created_at DESC" }), {
      sql: "SELECT * FROM users ORDER BY created_at DESC",
      params: [],
    });
  });

  it("1-4 DEFAULT", () => {
    const sql = "INSERT INTO users (email, status)\nVALUES (/*$email*/'user@example.com', /*$status*/'active')";
    assert.deepEqual(run(sql, { email: "alice@example.com", status: DEFAULT }), {
      sql: "INSERT INTO users (email, status)\nVALUES ($1, DEFAULT)",
      params: ["alice@example.com"],
    });
  });

  it("1-5 ALL", () => {
    assert.deepEqual(run("SELECT *\nFROM users\nLIMIT /*$limit*/10", { limit: ALL }), {
      sql: "SELECT *\nFROM users\nLIMIT ALL",
      params: [],
    });
  });

  it("1-6 LIKE contains", () => {
    const sql = "SELECT *\nFROM products\nWHERE name LIKE /*$search*/'100%' ESCAPE '\\'";
    assert.deepEqual(run(sql, { search: LIKE_CONTAINS("100%") }), {
      sql: "SELECT *\nFROM products\nWHERE name LIKE $1 ESCAPE '\\'",
      params: ["%100\\%%"],
    });
  });

  it("1-7 default-to", () => {
    const sql =
      "INSERT INTO users (\n  id,\n  email\n)\nVALUES (\n  /*$id default-to */DEFAULT,\n  /*$email*/'user@example.com'\n)";
    assert.deepEqual(run(sql, { email: "alice@example.com" }), {
      sql: "INSERT INTO users (\n  id,\n  email\n)\nVALUES (\n  DEFAULT,\n  $1\n)",
      params: ["alice@example.com"],
    });
    assert.deepEqual(run(sql, { id: 42, email: "a" }).params, [42, "a"]);
    // null は明示的な NULL。undefined は未指定
    assert.deepEqual(run(sql, { id: null, email: "a" }).params, [null, "a"]);
    assert.deepEqual(run(sql, { id: undefined, email: "a" }).params, ["a"]);
  });

  it("collection binding", () => {
    assert.deepEqual(run("WHERE id IN /*$ids*/(1,2,3)", { ids: [10, 20, 30] }), {
      sql: "WHERE id IN ($1, $2, $3)",
      params: [10, 20, 30],
    });
    assert.throws(
      () => run("WHERE id IN /*$ids*/(1,2,3)", { ids: [] }),
      (e: unknown) => e instanceof TrisqlError && e.code === "render/collection-empty",
    );
  });

  it("same scalar name reuses the placeholder", () => {
    assert.deepEqual(run("SELECT /*$a*/1 + /*$b*/2 + /*$a*/1", { a: 1, b: 2 }), {
      sql: "SELECT $1 + $2 + $1",
      params: [1, 2],
    });
  });

  it("keeps a cast after the sample", () => {
    assert.equal(
      run("WHERE t > /*$since*/'2024-01-01'::timestamptz AND n = /*$n*/1::int", { since: "x", n: 1 }).sql,
      "WHERE t > $1::timestamptz AND n = $2::int",
    );
  });

  it("dot path reads nested objects", () => {
    assert.deepEqual(run("WHERE id = /*$where.id*/1", { where: { id: 7 } }).params, [7]);
  });

  it("4-3 missing parameter", () => {
    assert.throws(
      () => run("SELECT * FROM users WHERE id = /*$id*/1", { ic: 42 }),
      (e: unknown) =>
        e instanceof TrisqlError &&
        e.code === "render/missing-parameter" &&
        e.message === "Missing query parameter: id",
    );
  });
});

describe("control flow", () => {
  it("2-1 if", () => {
    assert.deepEqual(run("SELECT * FROM users /*%if id */ WHERE id = /*$id*/1 /*%end*/", { id: 42 }), {
      sql: "SELECT * FROM users  WHERE id = $1",
      params: [42],
    });
    assert.deepEqual(run("SELECT * FROM users /*%if id */ WHERE id = /*$id*/1 /*%end*/", {}), {
      sql: "SELECT * FROM users",
      params: [],
    });
  });

  it("2-2 removes WHERE for falsy if", () => {
    const sql = "SELECT *\nFROM users\nWHERE\n/*%if active */\n  active = true\n/*%end */\n";
    assert.deepEqual(run(sql, { active: false }), { sql: "SELECT *\nFROM users", params: [] });
    assert.deepEqual(run(sql, { active: true }), { sql: "SELECT *\nFROM users\nWHERE\n  active = true", params: [] });
  });

  it("2-3 removes following AND for falsy if", () => {
    const sql =
      "SELECT *\nFROM users\nWHERE\n/*%if active */\n  active = true\n/*%end */\nAND status = /*$status*/'active'\n";
    assert.deepEqual(run(sql, { active: false, status: "active" }), {
      sql: "SELECT *\nFROM users\nWHERE\nstatus = $1",
      params: ["active"],
    });
  });

  it("2-4 elseif and else", () => {
    const sql =
      "SELECT *\nFROM users\nWHERE\n/*%if active */\n  active = true\n/*%elseif pending */\n  status = 'pending'\n/*%else */\n  status = 'inactive'\n/*%end */\n";
    assert.equal(run(sql, { active: false, pending: true }).sql, "SELECT *\nFROM users\nWHERE\n  status = 'pending'");
    assert.equal(run(sql, { active: false, pending: false }).sql, "SELECT *\nFROM users\nWHERE\n  status = 'inactive'");
  });

  it("2-5 inline elseif and else", () => {
    const sql =
      "SELECT *\nFROM users\nWHERE\n/*%if active */\n  active = true\n/*%elseif pending => status = 'pending' */\n/*%else => status = 'inactive' */\n/*%end */\n";
    assert.equal(run(sql, { active: false, pending: true }).sql, "SELECT *\nFROM users\nWHERE\nstatus = 'pending'");
  });

  it("2-6 conditional expressions", () => {
    const sql =
      "SELECT *\nFROM users\nWHERE\n/*%if (active and status = expected_status) or pending */\n  status = 'pending'\n/*%else */\n  status = 'inactive'\n/*%end */\n";
    assert.equal(
      run(sql, { active: false, status: "active", expected_status: "pending", pending: true }).sql,
      "SELECT *\nFROM users\nWHERE\n  status = 'pending'",
    );
    assert.equal(
      run(sql, { active: true, status: "x", expected_status: "x", pending: false }).sql,
      "SELECT *\nFROM users\nWHERE\n  status = 'pending'",
    );
  });

  it("truthiness: only null, undefined and false are falsy", () => {
    const sql = "SELECT 1 /*%if v */WHERE 1=1/*%end*/";
    assert.equal(run(sql, { v: 0 }).sql, "SELECT 1 WHERE 1=1");
    assert.equal(run(sql, { v: "" }).sql, "SELECT 1 WHERE 1=1");
    assert.equal(run(sql, { v: null }).sql, "SELECT 1");
    assert.equal(run(sql, {}).sql, "SELECT 1");
  });

  it("2-7 for with separator", () => {
    const sql =
      "UPDATE users\nSET\n/*%for item in items separating , */\n  /*!item.name*/display_name = /*$item.value*/'sample'\n/*%end */\nWHERE id = /*$id*/1";
    assert.deepEqual(
      run(sql, {
        id: 42,
        items: [
          { name: "display_name", value: "Alice" },
          { name: "status", value: "active" },
        ],
      }),
      { sql: "UPDATE users\nSET\n  display_name = $1,\n  status = $2\nWHERE id = $3", params: ["Alice", "active", 42] },
    );
  });

  it("for accepts a Record and validates keys", () => {
    const sql = "UPDATE users SET /*%for item in updates separating , */ /*!item.name*/x = /*$item.value*/1 /*%end*/";
    assert.deepEqual(run(sql, { updates: { a: 1, b: 2 } }), {
      sql: "UPDATE users SET  a = $1 , b = $2",
      params: [1, 2],
    });
    assert.throws(
      () => run(sql, { updates: { "a b": 1 } }),
      (e: unknown) => e instanceof TrisqlError && e.code === "render/for-key",
    );
    assert.throws(
      () => run(sql, { updates: {} }),
      (e: unknown) => e instanceof TrisqlError && e.code === "render/empty-set",
    );
  });
});

describe("declarations and comments", () => {
  it("3-1 doc and normal comments", () => {
    const sql =
      "/*:doc Loads a user by id. */\n/* This is a normal comment */\nSELECT * FROM users WHERE id = /*$id*/1";
    const template = parse(sql);
    assert.equal(template.doc, "Loads a user by id.");
    assert.deepEqual(render(template, { id: 42 }), {
      sql: "/* This is a normal comment */\nSELECT * FROM users WHERE id = $1",
      params: [42],
    });
  });

  it("rejects unknown declarations", () => {
    assert.throws(
      () => parse("/*:tags [:x] */ SELECT 1"),
      (e: unknown) => e instanceof TrisqlError && e.code === "parse/unknown-declaration",
    );
  });

  it("ignores sigils inside strings and line comments", () => {
    const sql = "SELECT '/*$notavar*/' AS s -- /*$alsonot*/1\nFROM t WHERE id = /*$id*/1";
    assert.deepEqual(run(sql, { id: 1 }), {
      sql: "SELECT '/*$notavar*/' AS s -- /*$alsonot*/1\nFROM t WHERE id = $1",
      params: [1],
    });
  });

  it("4-1 join", () => {
    const sql =
      "SELECT u.id,\n       o.id AS order_id\nFROM users u\nJOIN orders o\n  ON o.user_id = u.id\nWHERE u.status = /*$status*/'active'\n  AND o.state = /*$state*/'pending'\nORDER BY o.created_at DESC\nLIMIT /*$limit*/100";
    assert.deepEqual(run(sql, { status: "active", state: "pending", limit: 20 }), {
      sql: "SELECT u.id,\n       o.id AS order_id\nFROM users u\nJOIN orders o\n  ON o.user_id = u.id\nWHERE u.status = $1\n  AND o.state = $2\nORDER BY o.created_at DESC\nLIMIT $3",
      params: ["active", "pending", 20],
    });
  });
});
