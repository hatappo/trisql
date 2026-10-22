import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";
import esbuildPlugin from "../src/esbuild.ts";
import vitePlugin from "../src/vite.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "test", "fixtures", "bundler");
const out = join(fixture, "dist");
const expected = JSON.stringify({ sql: "SELECT id, email FROM users WHERE id = $1", params: [3] });

/** fixture には package.json を置かないので、出力を node で実行すると `tysql` はリポジトリ自身に解決される */
function run(file: string): string {
  return execFileSync(process.execPath, [file], { encoding: "utf8", cwd: root }).trim();
}

describe("bundler plugins", () => {
  mkdirSync(out, { recursive: true });
  after(() => rmSync(out, { recursive: true, force: true }));

  it("esbuild bundles .sql files", async () => {
    const outfile = join(out, "esbuild.mjs");
    await esbuild.build({
      entryPoints: [join(fixture, "main.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      external: ["tysql"],
      plugins: [esbuildPlugin()],
      logLevel: "silent",
    });
    const code = readFileSync(outfile, "utf8");
    assert.match(code, /defineQuery\(\{\s*raw/);
    assert.equal(run(outfile), expected);
  });

  it("vite builds .sql files", async () => {
    const outDir = join(out, "vite");
    await viteBuild({
      root: fixture,
      configFile: false,
      logLevel: "silent",
      plugins: [vitePlugin()],
      build: { ssr: "main.ts", outDir, emptyOutDir: true, rollupOptions: { external: ["tysql"] } },
    });
    const file = join(outDir, "main.js");
    const code = readFileSync(file, "utf8");
    assert.match(code, /defineQuery\(\{\s*raw/);
    assert.equal(run(file), expected);
  });
});
