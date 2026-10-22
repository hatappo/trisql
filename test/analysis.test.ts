import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { analyze } from "../src/analysis/analyze.ts";
import type { Describer } from "../src/analysis/describer.ts";
import { renderParams, renderRow } from "../src/analysis/module-types.ts";
import { openPgliteDescriber } from "../src/analysis/pglite.ts";
import { parse } from "../src/index.ts";

const DDL = `
  CREATE TYPE status AS ENUM ('active', 'inactive');
  CREATE TABLE users (
    id bigserial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text,
    status status NOT NULL DEFAULT 'active',
    tags text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE posts (
    id serial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    title text NOT NULL
  );
`;

describe("analyze", () => {
  let describer: Describer;
  before(async () => {
    describer = await openPgliteDescriber([DDL]);
  });
  after(() => describer.close());

  const run = async (sql: string) => {
    const a = await analyze(parse(sql), describer);
    return { params: renderParams(a.params), row: renderRow(a), diagnostics: a.diagnostics, a };
  };

  it("types params from columns and casts, rows from describe and NOT NULL", async () => {
    const r = await run(
      "SELECT id, email, name, status, tags FROM users WHERE id = /*$id*/1 AND created_at > /*$since*/'2024-01-01'::timestamptz",
    );
    assert.equal(r.params, "{ id: string; since: Date }");
    assert.equal(
      r.row,
      '{ id: string; email: string; name: string | null; status: "active" | "inactive"; tags: string[] }',
    );
    assert.deepEqual(r.diagnostics, []);
  });

  it("expression columns are nullable, collections become arrays", async () => {
    const r = await run("SELECT count(*)::int AS n, max(name) AS m FROM users WHERE id IN /*$ids*/(1, 2)");
    assert.equal(r.params, "{ ids: string[] }");
    assert.equal(r.row, "{ n: number | null; m: string | null }");
  });

  it("outer join makes the joined table's columns nullable", async () => {
    const r = await run("SELECT u.id, p.title FROM users u LEFT JOIN posts p ON p.user_id = u.id");
    assert.equal(r.row, "{ id: string; title: string | null }");
    const inner = await run("SELECT u.id, p.title FROM users u JOIN posts p ON p.user_id = u.id");
    assert.equal(inner.row, "{ id: string; title: string }");
  });

  it("DML without RETURNING has no row; VALUES accepts DEFAULT; default-to is optional", async () => {
    const r = await run("INSERT INTO users (id, email) VALUES (/*$id default-to */DEFAULT, /*$email*/'a')");
    assert.equal(r.params, "{ id?: string | DefaultValue; email: string | DefaultValue }");
    assert.equal(r.row, "never");
    const returning = await run("INSERT INTO users (email) VALUES (/*$email*/'a') RETURNING id");
    assert.equal(returning.row, "{ id: string }");
  });

  it("if operands, literal, raw, LIMIT and LIKE", async () => {
    const r = await run(
      "SELECT id FROM users WHERE /*%if active */status = 'active'/*%end*/ AND name LIKE /*$q*/'a%' AND email = /*^email*/'x' ORDER BY /*!orderBy*/id LIMIT /*$limit*/10",
    );
    assert.equal(
      r.params,
      "{ active?: boolean | null | undefined; q: string | LikePattern; email: string; orderBy: string; limit: string | AllValue }",
    );
  });

  it("if operand used as a bind elsewhere takes the bind's type; compare operands are unknown", async () => {
    const r = await run("SELECT id FROM users WHERE /*%if status = expected */status = /*$status*/'active'/*%end*/");
    assert.equal(r.params, '{ status?: "active" | "inactive"; expected?: unknown }');
  });

  it("for loops build element types and accept Record for name/value", async () => {
    const r = await run(
      "UPDATE users SET /*%for item in updates separating , */ /*!item.name*/name = /*$item.value*/'x' /*%end*/ WHERE id = /*$where.id*/1",
    );
    assert.equal(
      r.params,
      "{ updates: Array<{ name: string; value: string | DefaultValue }> | Record<string, string | DefaultValue>; where: { id: string } }",
    );
    assert.equal(r.row, "never");
  });

  it("describe errors become diagnostics at the template position", async () => {
    const r = await run("SELECT nope FROM users WHERE id = /*$id*/1");
    assert.equal(r.diagnostics.length, 1);
    const d = r.diagnostics[0] as { message: string; start: number };
    assert.match(d.message, /column "nope" does not exist/);
    assert.equal(d.start, "SELECT ".length);
    assert.equal(r.row, "unknown");
    assert.equal(r.params, "{ id: number }");
  });

  it("projects error positions through placeholders", async () => {
    const sql = "SELECT id FROM users WHERE id = /*$id*/1 AND nope = /*$x*/'a'";
    const r = await run(sql);
    const d = r.diagnostics[0] as { start: number };
    assert.equal(sql.slice(d.start, d.start + 4), "nope");
  });
});
