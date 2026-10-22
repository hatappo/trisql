/**
 * `.sql` ファイルを JS モジュールのソースに変える。ロードフックとバンドラプラグインが共用する。
 * テンプレートの解析と描画だけで動くので DB は要らない。
 */
import { parse } from "../core/parse.ts";

export function sqlModuleSource(path: string, sql: string): string {
  // 構文エラーは import 時に出す（モジュールを評価してからではなく）
  parse(sql);
  return [
    `import { defineQuery } from "tysql";`,
    `export const raw = ${JSON.stringify(sql)};`,
    `export default defineQuery({ raw, source: ${JSON.stringify(path)} });`,
    ``,
  ].join("\n");
}
