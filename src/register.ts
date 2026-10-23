/**
 * `node --import trisql/register main.ts` で `.sql` の import を有効にする。
 * Node の同期ロードフック（module.registerHooks）で `.sql` を JS モジュールに置き換える。
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { sqlModuleSource } from "./runtime/loader.ts";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".sql")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    return { format: "module", source: sqlModuleSource(path, readFileSync(path, "utf8")), shortCircuit: true };
  },
});
