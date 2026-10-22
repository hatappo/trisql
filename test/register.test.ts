import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sqlModuleSource } from "../src/runtime/loader.ts";

describe("register", () => {
  it("sqlModuleSource emits a defineQuery module", () => {
    const src = sqlModuleSource("/x/q.sql", "SELECT /*$id*/1");
    assert.match(src, /import \{ defineQuery \} from "tysql";/);
    assert.match(src, /export const raw = "SELECT \/\*\$id\*\/1";/);
    assert.match(src, /defineQuery\(\{ raw, source: "\/x\/q\.sql" \}\)/);
  });

  it("node --import tysql/register loads .sql files", () => {
    const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
    const main = fileURLToPath(new URL("./fixtures/register-main.ts", import.meta.url));
    const out = execFileSync(process.execPath, ["--import", register, main], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), {
      doc: "ユーザーを id で取得する",
      rendered: { sql: "SELECT id, email FROM users WHERE id = $1", params: [7] },
      source: true,
    });
  });
});
