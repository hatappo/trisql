/**
 * `import q from "./x.sql"` の実体。型は content mapper が与え、値はローダーが作る。
 */
import { TysqlError } from "../core/errors.ts";
import { parse, type Template } from "../core/parse.ts";
import { type Rendered, render } from "../core/render.ts";

/**
 * `run` が受け付けるクライアント。`pg` の Pool / Client / PoolClient、PGlite、Neon、pg-promise などが満たす。
 */
export interface QueryClient {
  query(text: string, values?: unknown[]): PromiseLike<{ rows: unknown[] }>;
}

/** パラメータ引数。必須キーがなければ省略できる。 */
// biome-ignore lint/complexity/noBannedTypes: 「全キーが optional か」の判定には {} extends P が要る
export type ParamsArg<P> = {} extends P ? [params?: P] : [params: P];

export interface Query<P, R> {
  /** テンプレートの原文 */
  readonly raw: string;
  /** doc 宣言の内容 */
  readonly doc: string | null;
  /** テンプレートの由来（ファイルパスなど）。エラーメッセージに使う */
  readonly source: string | null;
  render(...params: ParamsArg<P>): Rendered;
  /** すべての行 */
  run(client: QueryClient, ...params: ParamsArg<P>): Promise<R[]>;
  /** ちょうど 1 行。0 行または 2 行以上なら例外 */
  one(client: QueryClient, ...params: ParamsArg<P>): Promise<R>;
  /** 0 行なら null、1 行ならその行。2 行以上なら例外 */
  maybeOne(client: QueryClient, ...params: ParamsArg<P>): Promise<R | null>;
  /** 結果を捨てる（RETURNING のない DML 向け） */
  exec(client: QueryClient, ...params: ParamsArg<P>): Promise<void>;
  /** クライアントを束縛した版 */
  with(client: QueryClient): BoundQuery<P, R>;
}

export interface BoundQuery<P, R> {
  run(...params: ParamsArg<P>): Promise<R[]>;
  one(...params: ParamsArg<P>): Promise<R>;
  maybeOne(...params: ParamsArg<P>): Promise<R | null>;
  exec(...params: ParamsArg<P>): Promise<void>;
}

export type QueryDefinition = {
  raw: string;
  source?: string;
};

export function defineQuery<P = Record<string, unknown>, R = Record<string, unknown>>(
  def: QueryDefinition,
): Query<P, R> {
  const source = def.source ?? null;
  let template: Template;
  try {
    template = parse(def.raw);
  } catch (e) {
    if (e instanceof TysqlError && source !== null) {
      throw new TysqlError(e.code, `${source}: ${e.message}`, { ...spanOf(e), details: e.details, cause: e });
    }
    throw e;
  }

  const doRender = (params: P | undefined): Rendered => {
    try {
      return render(template, (params ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof TysqlError && source !== null) {
        throw new TysqlError(e.code, `${source}: ${e.message}`, { ...spanOf(e), details: e.details, cause: e });
      }
      throw e;
    }
  };
  const run = async (client: QueryClient, params: P | undefined): Promise<R[]> => {
    const rendered = doRender(params);
    const result = await client.query(rendered.sql, rendered.params);
    return result.rows as R[];
  };
  const one = async (client: QueryClient, params: P | undefined): Promise<R> => {
    const rows = await run(client, params);
    if (rows.length !== 1) {
      throw new TysqlError("query/cardinality", `${where(source)}Expected exactly one row, got ${rows.length}.`, {
        details: { rows: rows.length },
      });
    }
    return rows[0] as R;
  };
  const maybeOne = async (client: QueryClient, params: P | undefined): Promise<R | null> => {
    const rows = await run(client, params);
    if (rows.length > 1) {
      throw new TysqlError("query/cardinality", `${where(source)}Expected at most one row, got ${rows.length}.`, {
        details: { rows: rows.length },
      });
    }
    return (rows[0] ?? null) as R | null;
  };
  const exec = async (client: QueryClient, params: P | undefined): Promise<void> => {
    await run(client, params);
  };

  return {
    raw: def.raw,
    doc: template.doc,
    source,
    render: ((params?: P) => doRender(params)) as Query<P, R>["render"],
    run: ((client: QueryClient, params?: P) => run(client, params)) as Query<P, R>["run"],
    one: ((client: QueryClient, params?: P) => one(client, params)) as Query<P, R>["one"],
    maybeOne: ((client: QueryClient, params?: P) => maybeOne(client, params)) as Query<P, R>["maybeOne"],
    exec: ((client: QueryClient, params?: P) => exec(client, params)) as Query<P, R>["exec"],
    with(client: QueryClient): BoundQuery<P, R> {
      return {
        run: ((params?: P) => run(client, params)) as BoundQuery<P, R>["run"],
        one: ((params?: P) => one(client, params)) as BoundQuery<P, R>["one"],
        maybeOne: ((params?: P) => maybeOne(client, params)) as BoundQuery<P, R>["maybeOne"],
        exec: ((params?: P) => exec(client, params)) as BoundQuery<P, R>["exec"],
      };
    },
  };
}

function spanOf(e: TysqlError): { start?: number; end?: number } {
  return { ...(e.start === undefined ? {} : { start: e.start }), ...(e.end === undefined ? {} : { end: e.end }) };
}

function where(source: string | null): string {
  return source === null ? "" : `${source}: `;
}
