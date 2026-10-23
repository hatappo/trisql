#!/usr/bin/env node
/**
 * trisql の CLI。
 *
 *   trisql generate [--dry-run]   trisql.json の schema から CRUD テンプレートを生成する
 */
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./analysis/config.ts";
import type { Describer } from "./analysis/describer.ts";
import { describerError, openDescriber } from "./analysis/open.ts";
import { introspect } from "./generate/introspect.ts";
import { writeCrud } from "./generate/write.ts";

const USAGE = "Usage: trisql generate [--dry-run]";

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
  if (command !== "generate") {
    console.error(`Unknown command: ${command}\n${USAGE}`);
    return 1;
  }
  const config = loadConfig(process.cwd());
  const error = describerError(config);
  if (error !== null) {
    console.error(error);
    return 1;
  }
  const describer = await openDescriber(config);
  try {
    // await して返す。でないと finally が解析の途中で describer を閉じてしまう
    return await generate(config, describer, values["dry-run"]);
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
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
