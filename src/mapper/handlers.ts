/**
 * content mapper のハンドラ。tsc から見た `.sql` ファイルの姿を決める。
 * 位置はすべて UTF-16 コードユニット（initialize で "utf-16" を選ぶ）。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { analyze, DIAG, type Diagnostic } from "../analysis/analyze.ts";
import { type Config, loadConfig } from "../analysis/config.ts";
import type { Describer } from "../analysis/describer.ts";
import { virtualModule } from "../analysis/module-types.ts";
import { openPgliteDescriber } from "../analysis/pglite.ts";
import { TysqlError } from "../core/errors.ts";
import { parse } from "../core/parse.ts";

export type MapperDiagnostic = { messageText: string; start: number; length: number; code: number };
export type Transformed = { extension: ".ts"; text: string; mappings: number[][]; diagnostics: MapperDiagnostic[] };

type Project = {
  config: Config | null;
  /** 設定が読めなかった理由。毎 transform で診断にする */
  error: string | null;
  describer: Promise<Describer> | null;
};

const ATOM = 1;
const DEFINITION = 8;
const TYPE_DEFINITION = 16;
const IMPLEMENTATION = 32;

export class MapperHandlers {
  readonly #projects = new Map<string, Project>();

  initialize(params: unknown): { protocolVersion: number; positionEncoding: "utf-16"; diagnosticSource: "tysql" } {
    const { protocolVersion } = (params ?? {}) as { protocolVersion?: number };
    return { protocolVersion: protocolVersion ?? 1, positionEncoding: "utf-16", diagnosticSource: "tysql" };
  }

  openProject(params: unknown): { configIdentity: string; watchedFiles: string[]; optionDiagnostics: unknown[] } {
    const p = params as { projectHandle: string; configFileName: string; options?: Record<string, unknown> };
    const projectDir = dirname(p.configFileName);
    let config: Config | null = null;
    let error: string | null = null;
    try {
      config = loadConfig(projectDir);
      if (config.schema.length === 0 && config.databaseUrl === null) {
        error = `tysql needs a schema to type .sql files: add "schema" (DDL files) to ${config.file ?? "tysql.json"}.`;
      } else if (config.databaseUrl !== null) {
        error = `"databaseUrl" is not supported yet; use "schema" with an embedded PGlite.`;
      }
    } catch (e) {
      error = (e as Error).message;
    }
    this.#projects.set(p.projectHandle, { config, error, describer: null });
    const watchedFiles = config ? [...(config.file ? [config.file] : []), ...config.schema] : [];
    const identity = createHash("sha1")
      .update(JSON.stringify([config?.file ?? null, config?.schema ?? [], error, watchedFiles.map((f) => mtime(f))]))
      .digest("hex");
    const optionDiagnostics = Object.keys(p.options ?? {}).map((key) => ({
      path: [key],
      messageText: `tysql reads its settings from tysql.json, not from the content mapper's options; move "${key}" there.`,
      code: DIAG.config,
    }));
    return { configIdentity: identity, watchedFiles, optionDiagnostics };
  }

  async transform(params: unknown): Promise<Transformed> {
    const p = params as { fileName: string; content: string; projectHandle: string };
    const sql = p.content;
    const project = this.#projects.get(p.projectHandle);
    if (!project)
      return fallback(
        sql,
        "The content mapper has no project for this file; restart the TypeScript server.",
        DIAG.config,
      );
    if (project.error !== null || !project.config)
      return fallback(sql, project.error ?? "tysql: no configuration.", DIAG.config);

    let template: ReturnType<typeof parse>;
    try {
      template = parse(sql);
    } catch (e) {
      if (e instanceof TysqlError) return fallback(sql, e.message, DIAG.parse, e.start ?? 0, e.end ?? 1);
      throw e;
    }

    project.describer ??= openPgliteDescriber(project.config.schema.map((f) => readFileSync(f, "utf8")));
    let describer: Describer;
    try {
      describer = await project.describer;
    } catch (e) {
      project.describer = null;
      return fallback(sql, `Could not open the schema: ${(e as Error).message}`, DIAG.config);
    }
    const analysis = await analyze(template, describer);
    const text = virtualModule(analysis, sql, template.doc);
    return {
      extension: ".ts",
      text,
      mappings: mapToStatement(text, sql),
      diagnostics: analysis.diagnostics.map(toMapperDiagnostic),
    };
  }

  async closeProject(params: unknown): Promise<Record<never, never>> {
    const { projectHandle } = params as { projectHandle: string };
    const project = this.#projects.get(projectHandle);
    this.#projects.delete(projectHandle);
    if (project?.describer) await (await project.describer).close().catch(() => {});
    return {};
  }

  /** テスト用: 開いているプロジェクトをすべて閉じる */
  async closeAll(): Promise<void> {
    for (const handle of [...this.#projects.keys()]) await this.closeProject({ projectHandle: handle });
  }
}

function toMapperDiagnostic(d: Diagnostic): MapperDiagnostic {
  return { messageText: d.message, start: d.start, length: Math.max(1, d.end - d.start), code: d.code };
}

/** 解析できなかったファイルの姿: 型は unknown、診断を 1 つ */
function fallback(sql: string, message: string, code: number, start = 0, end = 1): Transformed {
  const text = [
    `import type { Query } from "tysql";`,
    `export type Params = unknown;`,
    `export type Row = unknown;`,
    `export declare const raw: string;`,
    `declare const query: Query<Record<string, unknown>, unknown>;`,
    `export default query;`,
    ``,
  ].join("\n");
  return {
    extension: ".ts",
    text,
    mappings: mapToStatement(text, sql),
    diagnostics: [{ messageText: message, start, length: Math.max(1, end - start), code }],
  };
}

/**
 * 仮想モジュール全体を文全体に 1 つの atom として対応づける。
 * どこから定義ジャンプしても `.sql` の文の先頭に着地する。
 */
function mapToStatement(text: string, sql: string): number[][] {
  let start = 0;
  let end = sql.length;
  while (start < end && /\s/.test(sql[start] as string)) start++;
  while (end > start && /\s/.test(sql[end - 1] as string)) end--;
  return [[0, text.length, start, end - start, ATOM, DEFINITION | TYPE_DEFINITION | IMPLEMENTATION]];
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
