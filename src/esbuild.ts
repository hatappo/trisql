/**
 * esbuild プラグイン。Bun.build の plugins にもそのまま渡せる（同じ onLoad の形）。
 *
 *   import trisql from "trisql/esbuild";
 *   await esbuild.build({ ..., plugins: [trisql()] });
 */
import { readFileSync } from "node:fs";
import { sqlModuleSource } from "./runtime/loader.ts";

type Build = {
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => { contents: string; loader: "js" }): void;
};

export default function trisql(): { name: string; setup(build: Build): void } {
  return {
    name: "trisql",
    setup(build) {
      build.onLoad({ filter: /\.sql$/ }, (args) => ({
        contents: sqlModuleSource(args.path, readFileSync(args.path, "utf8")),
        loader: "js",
      }));
    },
  };
}
