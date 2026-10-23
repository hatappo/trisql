import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MapperHandlers } from "../src/mapper/handlers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) => join(root, "test", "fixtures", name);

/** fixture から `trisql` パッケージが解決できるよう node_modules にシンボリックリンクを張る */
function linkTrisql(dir: string): void {
  const link = join(dir, "node_modules", "trisql");
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(root, link, "dir");
}

function tsc(dir: string): { status: number | null; stdout: string; stderr: string } {
  linkTrisql(dir);
  const bin = join(root, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [bin, "-p", dir, "--noEmit", "--runExternalCode"], {
    encoding: "utf8",
    cwd: dir,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("mapper handlers", () => {
  const handlers = new MapperHandlers();
  after(() => handlers.closeAll());

  it("types a .sql file against the schema in trisql.json", async () => {
    const dir = fixture("mapper-ok");
    const open = handlers.openProject({ projectHandle: "h1", configFileName: join(dir, "tsconfig.json") });
    assert.ok(open.watchedFiles.some((f) => f.endsWith("trisql.json")));
    assert.ok(open.watchedFiles.some((f) => f.endsWith("schema.sql")));
    const sql = "SELECT id, name FROM users WHERE id = /*$id*/1";
    const t = await handlers.transform({ fileName: join(dir, "x.sql"), content: sql, projectHandle: "h1" });
    assert.equal(t.extension, ".ts");
    assert.match(t.text, /export type Params = \{ id: string \| number \| bigint \};/);
    assert.match(t.text, /export type Row = \{ id: string; name: string \| null \};/);
    assert.deepEqual(t.diagnostics, []);
    // キーは Alias（種別 2）でテンプレート上の名前に対応し、残りは文全体への Atom（種別 1）
    const aliases = t.mappings
      .filter((m) => m[4] === 2)
      .map((m) => [
        t.text.slice(m[0], (m[0] as number) + (m[1] as number)),
        sql.slice(m[2], (m[2] as number) + (m[3] as number)),
        m[2],
      ]);
    // Params と Row は別名の定義と Query の型引数の 2 か所に書かれるので、重複を除いて比べる
    const unique = aliases.filter((a, i) => aliases.findIndex((b) => JSON.stringify(b) === JSON.stringify(a)) === i);
    assert.deepEqual(unique, [
      ["id", "id", sql.indexOf("/*$id*/") + 3],
      ["id", "id", "SELECT ".length],
      ["name", "name", "SELECT id, ".length],
    ]);
    const atoms = t.mappings.filter((m) => m[4] === 1);
    assert.ok(atoms.every((m) => m[2] === 0 && m[3] === sql.length));
    const starts = t.mappings.map((m) => m[0] as number);
    assert.deepEqual(
      starts,
      [...starts].sort((a, b) => a - b),
    );
  });

  it("reports SQL errors at their position and parse errors", async () => {
    const dir = fixture("mapper-ok");
    handlers.openProject({ projectHandle: "h2", configFileName: join(dir, "tsconfig.json") });
    const bad = await handlers.transform({
      fileName: join(dir, "bad.sql"),
      content: "SELECT nope FROM users",
      projectHandle: "h2",
    });
    assert.equal(bad.diagnostics.length, 1);
    assert.equal(bad.diagnostics[0]?.code, 2);
    assert.equal(bad.diagnostics[0]?.start, "SELECT ".length);
    assert.match(bad.text, /export type Row = unknown;/);
    const unparsable = await handlers.transform({
      fileName: join(dir, "p.sql"),
      content: "SELECT /*$x*/ 1",
      projectHandle: "h2",
    });
    assert.equal(unparsable.diagnostics[0]?.code, 1);
  });

  it("reports a missing configuration", async () => {
    const dir = fixture("no-config");
    mkdirSync(dir, { recursive: true });
    handlers.openProject({ projectHandle: "h3", configFileName: join(dir, "tsconfig.json") });
    const t = await handlers.transform({ fileName: join(dir, "q.sql"), content: "SELECT 1", projectHandle: "h3" });
    assert.equal(t.diagnostics[0]?.code, 3);
    assert.match(t.diagnostics[0]?.messageText ?? "", /schema/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tsc --runExternalCode", () => {
  it("type-checks a clean project with no errors", () => {
    const r = tsc(fixture("mapper-ok"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("reports type errors at the import site", () => {
    const r = tsc(fixture("mapper-errors"));
    assert.equal(r.status, 2);
    const lines = r.stdout.split("\n").filter((l) => l.includes("error TS"));
    const shown = lines.map((l) => l.replace(/^.*main\.ts/, "main.ts"));
    assert.equal(shown.length, 3, r.stdout);
    assert.match(
      shown[0] ?? "",
      /^main\.ts\(6,25\): error TS2353: .*'nope' does not exist in type '\{ id: string \| number \| bigint; \}'/,
    );
    assert.match(
      shown[1] ?? "",
      /^main\.ts\(8,25\): error TS2322: Type 'boolean' is not assignable to type 'string \| number \| bigint'/,
    );
    assert.match(
      shown[2] ?? "",
      /^main\.ts\(11,15\): error TS2339: Property 'missing' does not exist on type '\{ id: string; email: string; name: string \| null; status: "active" \| "inactive"; \}'/,
    );
  });
});

describe("declarations.auto", () => {
  it("writes .d.sql.ts beside the file on every successful transform", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trisql-auto-"));
    const handlers = new MapperHandlers();
    try {
      mkdirSync(join(dir, "db"));
      writeFileSync(join(dir, "db", "schema.sql"), "CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);");
      writeFileSync(
        join(dir, "trisql.json"),
        JSON.stringify({ schema: ["db/schema.sql"], declarations: { auto: true } }),
      );
      writeFileSync(join(dir, "package.json"), "{}");
      handlers.openProject({ projectHandle: "auto", configFileName: join(dir, "tsconfig.json") });
      const file = join(dir, "q.sql");
      const sql = "SELECT email FROM users WHERE id = /*$id*/1";
      writeFileSync(file, sql);
      await handlers.transform({ fileName: file, content: sql, projectHandle: "auto" });
      const decl = join(dir, "q.d.sql.ts");
      assert.ok(existsSync(decl));
      const text = readFileSync(decl, "utf8");
      assert.match(text, /^\/\/ Generated by trisql from q\.sql\. Do not edit\.\n/);
      assert.match(text, /export type Row = \{ email: string \};/);
      // 解析に失敗した文では古い宣言を壊さない
      await handlers.transform({ fileName: file, content: "SELECT nope FROM users", projectHandle: "auto" });
      assert.equal(readFileSync(decl, "utf8"), text);
    } finally {
      await handlers.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
