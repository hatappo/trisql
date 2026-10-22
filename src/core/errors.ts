/**
 * tysql のエラー。テンプレート上の位置（UTF-16 のコードユニット offset）を持てる。
 */
export class TysqlError extends Error {
  override readonly name = "TysqlError";
  readonly code: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: { start?: number; end?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.start = options.start;
    this.end = options.end;
    this.details = options.details ?? {};
  }
}
