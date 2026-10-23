import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { analyze } from "../src/analysis/analyze.ts";
import type { Describer } from "../src/analysis/describer.ts";
import { PgliteDescriber } from "../src/analysis/pglite.ts";
import { generateCrud } from "../src/generate/crud.ts";
import { introspect, type Table } from "../src/generate/introspect.ts";
import { barrel, exportName, writeCrud } from "../src/generate/write.ts";
import { defineQuery, LIKE_STARTS_WITH, parse } from "../src/index.ts";

const DDL = `
  CREATE TYPE status AS ENUM ('active', 'inactive');
  CREATE TABLE users (
    id bigserial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text,
    status status NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX users_status_idx ON users (status);
  CREATE INDEX users_status_name_idx ON users (status, name);
  CREATE TABLE posts (
    id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    title text NOT NULL,
    title_upper text GENERATED ALWAYS AS (upper(title)) STORED
  );
  CREATE INDEX posts_user_id_idx ON posts (user_id);
`;

describe("generate", () => {
  const db = new PGlite();
  let describer: Describer;
  let tables: Table[];
  let users: Table;
  before(async () => {
    await db.exec(DDL);
    describer = new PgliteDescriber(db);
    tables = await introspect(describer, ["public"]);
    users = tables.find((t) => t.name === "users") as Table;
  });
  after(() => describer.close());

  it("introspects tables, keys and indexes", () => {
    assert.deepEqual(
      tables.map((t) => t.name),
      ["posts", "users"],
    );
    assert.deepEqual(users.primaryKey, ["id"]);
    assert.deepEqual(users.uniqueGroups, [["id"], ["email"]]);
    assert.deepEqual(users.indexGroups, [["status"], ["status", "name"]]);
    const posts = tables.find((t) => t.name === "posts") as Table;
    assert.equal(posts.columns.find((c) => c.name === "id")?.identity, "a");
    assert.equal(posts.columns.find((c) => c.name === "title_upper")?.generated, "s");
  });

  it("generates the expected query families", () => {
    const names = generateCrud(users).map((q) => q.name);
    assert.deepEqual(names, [
      "insert",
      "insert-many",
      "get-by-id",
      "delete-by-id",
      "update-by-id",
      "upsert-by-id",
      "get-by-email",
      "delete-by-email",
      "update-by-email",
      "upsert-by-email",
      "list",
      "list-by-status",
      "list-by-status-order-by-name",
      "list-by-status-and-name",
      "list-by-email-starting-with",
      "list-by-status-and-name-starting-with",
      "count",
      "count-by-status",
      "count-by-status-and-name",
      "count-by-email-starting-with",
      "count-by-status-and-name-starting-with",
    ]);
    const posts = tables.find((t) => t.name === "posts") as Table;
    const insert = generateCrud(posts).find((q) => q.name === "insert")?.sql ?? "";
    assert.ok(!insert.includes("title_upper"), "generated columns are not inserted");
    assert.ok(!/\bid\b/.test(insert.split("VALUES")[0] ?? ""), "identity ALWAYS columns are not inserted");
  });

  it("insert uses default-to for defaultable columns", () => {
    const insert = generateCrud(users).find((q) => q.name === "insert")?.sql;
    assert.equal(
      insert,
      [
        "INSERT INTO users (",
        "  id,",
        "  email,",
        "  name,",
        "  status,",
        "  created_at",
        ")",
        "VALUES (",
        "  /*$id default-to */DEFAULT,",
        "  /*$email*/'sample',",
        "  /*$name default-to */DEFAULT,",
        "  /*$status default-to */DEFAULT,",
        "  /*$created_at default-to */DEFAULT",
        ")",
        "RETURNING *",
      ].join("\n"),
    );
  });

  it("every generated template parses and describes without diagnostics", async () => {
    for (const table of tables) {
      for (const q of generateCrud(table)) {
        const analysis = await analyze(parse(q.sql), describer);
        assert.deepEqual(analysis.diagnostics, [], `${table.name}/${q.name}:\n${q.sql}`);
      }
    }
  });

  it("generated templates run end to end", async () => {
    const queries = new Map(generateCrud(users).map((g) => [g.name, defineQuery({ raw: g.sql, source: g.name })]));
    const q = (name: string) => {
      const query = queries.get(name);
      assert.ok(query, name);
      return query;
    };
    const inserted = (await q("insert").one(db, { email: "a@example.com" })) as { email: string };
    assert.equal(inserted.email, "a@example.com");
    await q("insert-many").run(db, { rows: [{ email: "b@example.com", name: "B" }, { email: "c@example.com" }] });
    assert.equal(((await q("count").one(db, {})) as { count: number }).count, 3);
    const updated = (await q("update-by-email").one(db, {
      where: { email: "a@example.com" },
      updates: { name: "A" },
    })) as { name: string };
    assert.equal(updated.name, "A");
    const upserted = (await q("upsert-by-email").one(db, {
      inserts: { email: "a@example.com" },
      updates: { status: "inactive" },
    })) as { status: string };
    assert.equal(upserted.status, "inactive");
    const listed = (await q("list-by-status").run(db, { status: "active", limit: 10 })) as { email: string }[];
    assert.deepEqual(listed.map((r) => r.email).sort(), ["b@example.com", "c@example.com"]);
    const prefix = (await q("list-by-email-starting-with").run(db, { email: LIKE_STARTS_WITH("b"), limit: 10 })) as {
      email: string;
    }[];
    assert.equal(prefix.length, 1);
    await q("delete-by-email").exec(db, { email: "c@example.com" });
    assert.equal(((await q("count").one(db, {})) as { count: number }).count, 2);
  });

  it("writes files and a barrel, and removes stale files", () => {
    const dir = mkdtempSync(join(tmpdir(), "trisql-gen-"));
    try {
      const first = writeCrud(dir, tables);
      assert.ok(first.written.some((f) => f.endsWith(join("public", "users", "crud", "get-by-id.sql"))));
      const index = readFileSync(join(dir, "public", "users", "crud", "index.ts"), "utf8");
      assert.match(index, /export \{ default as getById \} from "\.\/get-by-id\.sql";/);
      assert.match(index, /export \{ default as listByStatusAndNameStartingWith \} from/);
      writeFileSync(join(dir, "public", "users", "crud", "stale.sql"), "SELECT 1");
      const second = writeCrud(dir, tables);
      assert.deepEqual(second.written, []);
      assert.ok(second.removed.some((f) => f.endsWith("stale.sql")));
      assert.ok(!readdirSync(join(dir, "public", "users", "crud")).includes("stale.sql"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names exports in camelCase", () => {
    assert.equal(exportName("list-by-status-and-name-starting-with"), "listByStatusAndNameStartingWith");
    assert.equal(
      barrel(["insert"]),
      '// Generated by trisql. Do not edit.\nexport { default as insert } from "./insert.sql";\n',
    );
  });
});
