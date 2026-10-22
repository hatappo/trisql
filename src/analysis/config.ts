/**
 * 設定ファイル `tysql.json`。ファイルのディレクトリから上へ辿って最初に見つかったものを使う。
 *
 *   {
 *     "schema": ["db/migrations/*.sql"],      // 内包 PGlite に適用する DDL（glob、root 相対）
 *     "databaseUrl": "${DATABASE_URL}",       // 指定時は実 DB に接続する（未実装）
 *   }
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TysqlError } from "../core/errors.ts";

export const CONFIG_FILE = "tysql.json";

export type Config = {
  /** 設定ファイルのパス。見つからなければ null */
  file: string | null;
  /** 相対パスの基準。設定ファイルのディレクトリ、なければ最寄りの package.json のディレクトリ */
  root: string;
  /** DDL ファイルの絶対パス（ソート済み） */
  schema: string[];
  databaseUrl: string | null;
};

type ConfigFile = { schema?: string | string[]; databaseUrl?: string };

/** `from` から上へ辿り、最初に見つかった名前のファイルのパスを返す。 */
export function findUp(from: string, name: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

export function loadConfig(fromDir: string, env: Record<string, string | undefined> = process.env): Config {
  const file = findUp(fromDir, CONFIG_FILE);
  const pkg = findUp(fromDir, "package.json");
  const root = file ? dirname(file) : pkg ? dirname(pkg) : resolve(fromDir);
  let parsed: ConfigFile = {};
  if (file) {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as ConfigFile;
    } catch (e) {
      throw new TysqlError("config/invalid", `${file}: ${(e as Error).message}`, { cause: e });
    }
  }
  const patterns = parsed.schema === undefined ? [] : Array.isArray(parsed.schema) ? parsed.schema : [parsed.schema];
  const schema = patterns
    .flatMap((pattern) => globSync(pattern, { cwd: root }).map((p) => resolve(root, p)))
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort();
  const databaseUrl =
    parsed.databaseUrl === undefined ? null : substituteEnv(parsed.databaseUrl, env, file ?? CONFIG_FILE);
  if (patterns.length > 0 && schema.length === 0) {
    throw new TysqlError("config/no-schema-files", `${file}: "schema" matched no files: ${patterns.join(", ")}`);
  }
  return { file, root, schema, databaseUrl };
}

function substituteEnv(value: string, env: Record<string, string | undefined>, file: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined)
      throw new TysqlError("config/missing-env", `${file}: environment variable ${name} is not set.`);
    return v;
  });
}
