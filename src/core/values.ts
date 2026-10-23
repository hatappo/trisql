/**
 * バインド値として渡せる特殊値。
 */
export const DEFAULT: unique symbol = Symbol.for("trisql.DEFAULT");
export const ALL: unique symbol = Symbol.for("trisql.ALL");
export type DefaultValue = typeof DEFAULT;
export type AllValue = typeof ALL;

const likeBrand: unique symbol = Symbol.for("trisql.LikePattern");
export type LikeMode = "startsWith" | "endsWith" | "contains";

export class LikePattern {
  readonly [likeBrand] = true;
  readonly mode: LikeMode;
  readonly value: string;

  constructor(mode: LikeMode, value: string) {
    this.mode = mode;
    this.value = value;
    if (typeof value !== "string") throw new TypeError("LIKE helpers require a string value.");
  }

  /** `%`, `_`, `\` をエスケープし、mode に応じて `%` を付けた LIKE パターン。 */
  toPattern(): string {
    const escaped = this.value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    switch (this.mode) {
      case "startsWith":
        return `${escaped}%`;
      case "endsWith":
        return `%${escaped}`;
      case "contains":
        return `%${escaped}%`;
    }
  }
}

export function LIKE_STARTS_WITH(value: string): LikePattern {
  return new LikePattern("startsWith", value);
}
export function LIKE_ENDS_WITH(value: string): LikePattern {
  return new LikePattern("endsWith", value);
}
export function LIKE_CONTAINS(value: string): LikePattern {
  return new LikePattern("contains", value);
}

export function isLikePattern(value: unknown): value is LikePattern {
  return value instanceof LikePattern;
}
