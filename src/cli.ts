#!/usr/bin/env node
/**
 * trisql の CLI。
 *
 *   trisql generate [--dry-run]              trisql.json の schema から CRUD テンプレートと宣言ファイルを生成する
 *   trisql declarations [--dry-run] [glob..] `.sql` の隣に `.d.sql.ts` を書く（省略時は trisql.json の declarations と generate の出力先）
 */
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./analysis/config.ts";
import type { Describer } from "./analysis/describer.ts";
import { describerError, openDescriber } from "./analysis/open.ts";
import { writeDeclarations } from "./generate/declarations.ts";
import { introspect } from "./generate/introspect.ts";
import { writeCrud } from "./generate/write.ts";

const USAGE = "Usage: trisql generate [--dry-run]\n       trisql declarations [--dry-run] [glob...]";

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  if (command !== "generate" && command !== "declarations") {
    console.error(`Unknown command: ${command}\n${USAGE}`);
    return 1;
  }
  const config = loadConfig(process.cwd());
  const error = describerError(config);
  if (error !== null) {
    console.error(error);
    return 1;
  }
  const dryRun = values["dry-run"];
  const describer = await openDescriber(config);
  try {
    if (command === "generate") return await generate(config, describer, dryRun);
    return await declarations(config, describer, dryRun, positionals.slice(1));
  } finally {
    await describer.close();
  }
}

async function generate(config: Config, describer: Describer, dryRun: boolean): Promise<number> {
  const tables = await introspect(describer, config.generate.schemas);
  if (tables.length === 0) {
    console.error(`No tables found in schema(s): ${config.generate.schemas.join(", ")}`);
    return 1;
  }
  const result = writeCrud(config.generate.out, tables, { dryRun });
  const verb = dryRun ? "would write" : "wrote";
  for (const f of result.written) console.log(`${verb} ${f}`);
  for (const f of result.removed) console.log(`${dryRun ? "would remove" : "removed"} ${f}`);
  console.log(
    `${tables.length} table(s): ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed`,
  );
  // 生成した .sql と設定の declarations の宣言ファイル。dry-run では生成前のファイルが無いので生成分は飛ばす
  const files = dryRun ? config.declarations : [...new Set([...result.sqlFiles, ...config.declarations])].sort();
  return files.length === 0 ? 0 : declarations(config, describer, dryRun, [], files);
}

async function declarations(
  config: Config,
  describer: Describer,
  dryRun: boolean,
  globs: string[],
  files?: string[],
): Promise<number> {
  const targets =
    files ??
    (globs.length > 0
      ? globs
          .flatMap((g) => globSync(g, { cwd: process.cwd() }).map((p) => resolve(process.cwd(), p)))
          .filter((p) => p.endsWith(".sql"))
      : [
          ...new Set([
            ...globSync("**/*.sql", { cwd: config.generate.out }).map((p) => resolve(config.generate.out, p)),
            ...config.declarations,
          ]),
        ]);
  const sorted = [...new Set(targets)].sort();
  if (sorted.length === 0) {
    console.error('No .sql files to declare: pass globs, or set "declarations" in trisql.json.');
    return 1;
  }
  const result = await writeDeclarations(sorted, describer, { dryRun });
  const verb = dryRun ? "would write" : "wrote";
  for (const f of result.written) console.log(`${verb} ${f}`);
  for (const f of result.failed) console.error(`skipped ${f.file}: ${f.message}`);
  console.log(
    `declarations: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.failed.length} skipped`,
  );
  return result.failed.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
