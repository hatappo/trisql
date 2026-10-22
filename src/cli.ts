#!/usr/bin/env node
/**
 * tysql の CLI。
 *
 *   tysql generate [--dry-run]   tysql.json の schema から CRUD テンプレートを生成する
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./analysis/config.ts";
import { describerError, openDescriber } from "./analysis/open.ts";
import { introspect } from "./generate/introspect.ts";
import { writeCrud } from "./generate/write.ts";

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log("Usage: tysql generate [--dry-run]");
    return command === undefined && !values.help ? 1 : 0;
  }
  if (command !== "generate") {
    console.error(`Unknown command: ${command}`);
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
    const tables = await introspect(describer, config.generate.schemas);
    if (tables.length === 0) {
      console.error(`No tables found in schema(s): ${config.generate.schemas.join(", ")}`);
      return 1;
    }
    const result = writeCrud(config.generate.out, tables, { dryRun: values["dry-run"] });
    const verb = values["dry-run"] ? "would write" : "wrote";
    for (const f of result.written) console.log(`${verb} ${f}`);
    for (const f of result.removed) console.log(`${values["dry-run"] ? "would remove" : "removed"} ${f}`);
    console.log(
      `${tables.length} table(s): ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed`,
    );
    return 0;
  } finally {
    await describer.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
