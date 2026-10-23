import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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
    assert.deepEqual(aliases, [
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
    assert.deepEqual(
      lines.map((l) => l.replace(/^.*main\.ts/, "main.ts")),
      [
        "main.ts(6,25): error TS2353: Object literal may only specify known properties, and 'nope' does not exist in type 'Params'.",
        "main.ts(8,25): error TS2322: Type 'boolean' is not assignable to type 'string | number | bigint'.",
        "main.ts(11,15): error TS2339: Property 'missing' does not exist on type 'Row'.",
      ],
    );
  });
});
