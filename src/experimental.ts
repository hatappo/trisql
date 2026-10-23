/**
 * trisql の解析と生成の API（実験的）。
 *
 * スキャフォールダやコード生成器など、外部ツールが trisql のテーブル定義や解析結果を使うための入口。
 * semver の対象外で、マイナー・パッチリリースでも予告なく変わる。依存する場合は版を固定すること。
 *
 *   import { introspect, loadConfig, openDescriber } from "trisql/experimental";
 *
 * @experimental
 */

// テンプレートの解析（Params / Row / 行数）
export { type Analysis, analyze, type Diagnostic, type ParamNode } from "./analysis/analyze.ts";
// 設定と DB への問い合わせ
export { type Config, loadConfig } from "./analysis/config.ts";
export type { Describer } from "./analysis/describer.ts";
export { describerError, openDescriber } from "./analysis/open.ts";
export type { Cardinality } from "./analysis/tree.ts";
export { type GeneratedQuery, generateCrud } from "./generate/crud.ts";
// テーブル定義と CRUD 生成
export { type Column, introspect, type Table } from "./generate/introspect.ts";
export { crudDir, exportName, type WriteResult, writeCrud } from "./generate/write.ts";
