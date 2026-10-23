// 公開 API の存在確認。スキャフォールダなど外部ツールが依存する入口が揃っていること
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as api from "../src/index.ts";

describe("public API", () => {
  it("exports the runtime, analysis and generator entry points", () => {
    for (const name of [
      "defineQuery",
      "parse",
      "render",
      "analyze",
      "loadConfig",
      "openDescriber",
      "openPgliteDescriber",
      "openPgDescriber",
      "introspect",
      "generateCrud",
      "writeCrud",
      "writeDeclarations",
      "renderParams",
      "renderRow",
      "virtualModule",
      "exportName",
      "crudDir",
    ]) {
      assert.equal(typeof (api as Record<string, unknown>)[name], "function", name);
    }
  });
});
