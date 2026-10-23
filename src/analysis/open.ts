/**
 * 設定から Describer を開く。`databaseUrl` があれば実 DB、なければ内包 PGlite に DDL を適用する。
 */
import { readFileSync } from "node:fs";
import { TrisqlError } from "../core/errors.ts";
import type { Config } from "./config.ts";
import type { Describer } from "./describer.ts";
import { openPgDescriber } from "./pg.ts";
import { openPgliteDescriber } from "./pglite.ts";

export function describerError(config: Config): string | null {
  if (config.schema.length === 0 && config.databaseUrl === null) {
    return `trisql needs a schema to type .sql files: add "schema" (DDL files) or "databaseUrl" to ${config.file ?? "trisql.json"}.`;
  }
  return null;
}

export async function openDescriber(config: Config): Promise<Describer> {
  const error = describerError(config);
  if (error !== null) throw new TrisqlError("config/no-schema", error);
  if (config.databaseUrl !== null) return openPgDescriber(config.databaseUrl);
  return openPgliteDescriber(config.schema.map((f) => readFileSync(f, "utf8")));
}
