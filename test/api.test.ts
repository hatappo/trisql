// 公開 API の範囲の確認。ルートはランタイムだけ、解析と生成は trisql/experimental から
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as experimental from "../src/experimental.ts";
import * as api from "../src/index.ts";

const functions = (mod: Record<string, unknown>) =>
  Object.keys(mod)
    .filter((k) => typeof mod[k] === "function")
    .sort();

describe("public API", () => {
  it("the root exports the runtime only", () => {
    assert.deepEqual(functions(api), [
      "LIKE_CONTAINS",
      "LIKE_ENDS_WITH",
      "LIKE_STARTS_WITH",
      "LikePattern",
      "TrisqlError",
      "defineQuery",
      "parse",
      "render",
    ]);
  });

  it("trisql/experimental exports the analysis and generator entry points", () => {
    assert.deepEqual(functions(experimental), [
      "analyze",
      "crudDir",
      "describerError",
      "exportName",
      "generateCrud",
      "introspect",
      "loadConfig",
      "openDescriber",
      "writeCrud",
    ]);
  });
});
