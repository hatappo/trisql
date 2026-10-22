/**
 * Vite プラグイン（Rollup / Rolldown でも同じ load フックで動く）。
 *
 *   import tysql from "tysql/vite";
 *   export default defineConfig({ plugins: [tysql()] });
 *
 * `.sql` はサーバー側のコードからだけ import すること。ブラウザにバンドルしても DB には届かない。
 */
import { readFileSync } from "node:fs";
import { sqlModuleSource } from "./runtime/loader.ts";

export default function tysql(): {
  name: string;
  enforce: "pre";
  load(id: string): { code: string; map: null } | null;
} {
  return {
    name: "tysql",
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".sql")) return null;
      const path = id.replace(/[?#].*$/, "");
      return { code: sqlModuleSource(path, readFileSync(path, "utf8")), map: null };
    },
  };
}
