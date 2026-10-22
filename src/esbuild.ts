/**
 * esbuild プラグイン。Bun.build の plugins にもそのまま渡せる（同じ onLoad の形）。
 *
 *   import tysql from "tysql/esbuild";
 *   await esbuild.build({ ..., plugins: [tysql()] });
 */
import { readFileSync } from "node:fs";
import { sqlModuleSource } from "./runtime/loader.ts";

type Build = {
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => { contents: string; loader: "js" }): void;
};

export default function tysql(): { name: string; setup(build: Build): void } {
  return {
    name: "tysql",
    setup(build) {
      build.onLoad({ filter: /\.sql$/ }, (args) => ({
        contents: sqlModuleSource(args.path, readFileSync(args.path, "utf8")),
        loader: "js",
      }));
    },
  };
}
