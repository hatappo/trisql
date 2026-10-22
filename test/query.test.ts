import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { defineQuery, TysqlError } from "../src/index.ts";

describe("defineQuery", () => {
  const db = new PGlite();
  before(async () => {
    await db.exec(`
      CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);
      INSERT INTO users VALUES (1, 'a@example.com'), (2, 'b@example.com');
    `);
  });
  after(() => db.close());

  const byId = defineQuery<{ id: number }, { id: number; email: string }>({
    raw: "SELECT id, email FROM users WHERE id = /*$id*/1",
    source: "by-id.sql",
  });
  const all = defineQuery<Record<never, never>, { id: number }>({ raw: "SELECT id FROM users ORDER BY id" });

  it("run returns all rows", async () => {
    assert.deepEqual(await all.run(db), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(await byId.run(db, { id: 1 }), [{ id: 1, email: "a@example.com" }]);
  });

  it("one / maybeOne / exec", async () => {
    assert.deepEqual(await byId.one(db, { id: 2 }), { id: 2, email: "b@example.com" });
    assert.equal(await byId.maybeOne(db, { id: 99 }), null);
    await assert.rejects(
      byId.one(db, { id: 99 }),
      (e: unknown) => e instanceof TysqlError && e.code === "query/cardinality" && e.message.startsWith("by-id.sql: "),
    );
    await assert.rejects(all.maybeOne(db), (e: unknown) => e instanceof TysqlError && e.code === "query/cardinality");
    const insert = defineQuery<{ id: number; email: string }, never>({
      raw: "INSERT INTO users (id, email) VALUES (/*$id*/3, /*$email*/'c@example.com')",
    });
    assert.equal(await insert.exec(db, { id: 3, email: "c@example.com" }), undefined);
    assert.equal((await all.run(db)).length, 3);
  });

  it("with binds the client", async () => {
    const bound = byId.with(db);
    assert.deepEqual(await bound.one({ id: 1 }), { id: 1, email: "a@example.com" });
  });

  it("render and metadata", () => {
    assert.deepEqual(byId.render({ id: 5 }), { sql: "SELECT id, email FROM users WHERE id = $1", params: [5] });
    assert.equal(byId.raw, "SELECT id, email FROM users WHERE id = /*$id*/1");
    assert.equal(byId.doc, null);
    assert.equal(defineQuery({ raw: "/*:doc hello */ SELECT 1" }).doc, "hello");
  });

  it("errors carry the source", () => {
    assert.throws(
      () => byId.render({} as { id: number }),
      (e: unknown) => e instanceof TysqlError && e.message === "by-id.sql: Missing query parameter: id",
    );
    assert.throws(
      () => defineQuery({ raw: "SELECT /*$x*/ 1", source: "bad.sql" }),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/missing-sample" && e.message.startsWith("bad.sql: "),
    );
  });
});
