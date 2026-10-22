/**
 * 型付けに必要な DB への問い合わせを抽象化する。実装は PGlite（既定）と実 DB（予定）。
 */
export type DescribedColumn = { name: string; oid: number; table: number; attnum: number };
export type Described = {
  /** 各 `$n` の型 OID */
  params: number[];
  /** 結果列。行を返さない文（noData）では null */
  columns: DescribedColumn[] | null;
};

export class DescribeError extends Error {
  override readonly name = "DescribeError";
  readonly code: string | null;
  /** 1 始まりの文字位置（Postgres の `position`）。不明なら null */
  readonly position: number | null;
  readonly hint: string | null;
  constructor(
    message: string,
    options: { code?: string | null; position?: number | null; hint?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? null;
    this.position = options.position ?? null;
    this.hint = options.hint ?? null;
  }
}

export interface Describer {
  /** Parse + Describe。実行はしない。文が不正なら DescribeError */
  describe(sql: string): Promise<Described>;
  /** カタログ照会 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}
