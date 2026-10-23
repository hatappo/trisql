// 実 DB 用の Describer（pg ドライバ）を、PGlite のソケットサーバーに接続して検証する。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { analyze } from "../src/analysis/analyze.ts";
import type { Describer } from "../src/analysis/describer.ts";
import { renderParams, renderRow } from "../src/analysis/module-types.ts";
import { openPgDescriber } from "../src/analysis/pg.ts";
import { PgliteDescriber } from "../src/analysis/pglite.ts";
import { parse } from "../src/index.ts";
import { MapperHandlers } from "../src/mapper/handlers.ts";

const DDL = `
  CREATE TYPE status AS ENUM ('active', 'inactive');
  CREATE TABLE users (id bigserial PRIMARY KEY, email text NOT NULL UNIQUE, name text, status status NOT NULL DEFAULT 'active');
  CREATE TABLE posts (id serial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), title text NOT NULL);
`;
const PORT = 54000 + Math.floor(Math.random() * 1000);

describe("pg describer over pglite-socket", () => {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  let pg: Describer;
  const url = `postgres://127.0.0.1:${PORT}/postgres`;
  before(async () => {
    await db.exec(DDL);
    await server.start();
    pg = await openPgDescriber(url);
  });
  after(async () => {
    await pg.close().catch(() => {});
    await server.stop();
    await db.close();
  });

  it("describes like the embedded PGlite describer", async () => {
    const sql =
      "SELECT u.id, u.name, p.title, count(*)::int AS n FROM users u LEFT JOIN posts p ON p.user_id = u.id WHERE u.id = /*$id*/1 AND u.status = /*$status*/'active' GROUP BY u.id, p.title";
    const viaPg = await analyze(parse(sql), pg);
    // ソケットサーバーが掴んでいる db は直接使わず、別の PGlite で比較する
    const own = new PGlite();
    await own.exec(DDL);
    const viaPglite = await analyze(parse(sql), new PgliteDescriber(own));
    await own.close();
    assert.equal(renderParams(viaPg.params), renderParams(viaPglite.params));
    assert.equal(renderRow(viaPg), renderRow(viaPglite));
    assert.equal(renderRow(viaPg), "{ id: string; name: string | null; title: string | null; n: number | null }");
    assert.deepEqual(viaPg.diagnostics, []);
  });

  it("reports errors with a position, and no row for DML", async () => {
    const bad = await analyze(parse("SELECT nope FROM users"), pg);
    assert.equal(bad.diagnostics[0]?.start, "SELECT ".length);
    assert.match(bad.diagnostics[0]?.message ?? "", /nope/);
    const dml = await analyze(parse("DELETE FROM posts WHERE id = /*$id*/1"), pg);
    assert.equal(renderRow(dml), "never");
    assert.equal(renderParams(dml.params), "{ id: number }");
  });

  it("the mapper uses databaseUrl from trisql.json", async () => {
    // ソケットサーバーは同時 1 接続なので、先に pg 側の接続を閉じる
    await pg.close();
    const dir = mkdtempSync(join(tmpdir(), "trisql-pg-"));
    const handlers = new MapperHandlers();
    try {
      writeFileSync(
        join(dir, "trisql.json"),
        JSON.stringify({ databaseUrl: ["$", "{TRISQL_TEST_DATABASE_URL}"].join("") }),
      );
      writeFileSync(join(dir, "package.json"), "{}");
      process.env.TRISQL_TEST_DATABASE_URL = url;
      handlers.openProject({ projectHandle: "pg", configFileName: join(dir, "tsconfig.json") });
      const t = await handlers.transform({
        fileName: join(dir, "q.sql"),
        content: "SELECT email FROM users WHERE id = /*$id*/1",
        projectHandle: "pg",
      });
      assert.deepEqual(t.diagnostics, []);
      assert.match(t.text, /export type Row = \{ email: string \};/);
    } finally {
      await handlers.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
