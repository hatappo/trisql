/**
 * テンプレートの走査。SQL テキストを「テキスト」と「sigil 付きブロックコメント」に分ける。
 *
 * 文字列リテラル（'...', E'...', $tag$...$tag$）、引用識別子（"..."）、行コメント（--）、
 * sigil なしのブロックコメント（入れ子可）は読み飛ばし、テキストの一部として扱う。
 * sigil 付きコメントは入れ子を持たず、最初の `*​/` で終わる。
 *
 * offset はすべて UTF-16 コードユニット単位の文字列 index。
 */
import { TysqlError } from "./errors.ts";

export type Sigil = "$" | "^" | "!" | "%" | ":";

export type TextSegment = { kind: "text"; start: number; end: number };
export type CommentSegment = {
  kind: "comment";
  sigil: Sigil;
  /** sigil の次の文字から `*​/` の直前まで */
  body: string;
  bodyStart: number;
  start: number;
  end: number;
};
export type Segment = TextSegment | CommentSegment;

const SIGILS: ReadonlySet<string> = new Set(["$", "^", "!", "%", ":"]);

export function isSigil(ch: string): ch is Sigil {
  return SIGILS.has(ch);
}

export function scan(source: string): Segment[] {
  const segments: Segment[] = [];
  const length = source.length;
  let textStart = 0;
  let i = 0;

  const flushText = (end: number) => {
    if (end > textStart) segments.push({ kind: "text", start: textStart, end });
  };

  while (i < length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === "'") {
      i = skipQuoted(source, i, "'", false);
      continue;
    }
    if ((ch === "E" || ch === "e") && next === "'") {
      i = skipQuoted(source, i + 1, "'", true);
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(source, i, '"', false);
      continue;
    }
    if (ch === "$") {
      const end = skipDollarQuoted(source, i);
      if (end !== undefined) {
        i = end;
        continue;
      }
    }
    if (ch === "-" && next === "-") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? length : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const sigilChar = source[i + 2];
      if (sigilChar !== undefined && isSigil(sigilChar)) {
        const close = source.indexOf("*/", i + 3);
        if (close === -1) {
          throw new TysqlError("scan/unterminated-directive", "Unterminated directive comment.", {
            start: i,
            end: length,
          });
        }
        flushText(i);
        segments.push({
          kind: "comment",
          sigil: sigilChar,
          body: source.slice(i + 3, close),
          bodyStart: i + 3,
          start: i,
          end: close + 2,
        });
        i = close + 2;
        textStart = i;
        continue;
      }
      i = skipBlockComment(source, i);
      continue;
    }
    i += 1;
  }
  flushText(length);
  return segments;
}

/** `start` は開き引用符の位置。閉じ引用符の次の位置を返す。 */
export function skipQuoted(source: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new TysqlError("scan/unterminated-string", "Unterminated quoted string.", { start, end: source.length });
}

/** `start` は `$` の位置。dollar quoting ならその終端の次の位置、そうでなければ undefined。 */
export function skipDollarQuoted(source: string, start: number): number | undefined {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(start));
  if (!m) return undefined;
  const tag = m[0];
  const close = source.indexOf(tag, start + tag.length);
  if (close === -1) {
    throw new TysqlError("scan/unterminated-string", "Unterminated dollar-quoted string.", {
      start,
      end: source.length,
    });
  }
  return close + tag.length;
}

/** `start` は `/*` の位置。入れ子に対応し、閉じの次の位置を返す。 */
export function skipBlockComment(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      depth += 1;
      i += 2;
      continue;
    }
    if (source[i] === "*" && source[i + 1] === "/") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  throw new TysqlError("scan/unterminated-comment", "Unterminated block comment.", { start, end: source.length });
}
