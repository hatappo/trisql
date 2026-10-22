/**
 * テンプレートを AST にする。
 */
import { TysqlError } from "./errors.ts";
import { type Expr, parseExpr } from "./expr.ts";
import { type CommentSegment, scan, skipDollarQuoted, skipQuoted } from "./scan.ts";

export type Span = { start: number; end: number };

export type TextNode = Span & { kind: "text"; text: string };
export type VariableNode = Span & {
  kind: "bind" | "literal" | "raw";
  /** `item.value` のような dot path */
  path: string[];
  /** path の位置（定義ジャンプ用） */
  name: Span;
  /** サンプル値のテキストと位置 */
  sample: string;
  sampleSpan: Span;
  /** `$` のコレクションバインド（サンプルが括弧で囲まれている） */
  collection: boolean;
  /** `default-to` 修飾子 */
  defaultTo: boolean;
};
export type Branch = Span & { expr: Expr | null; body: Node[] };
export type IfNode = Span & { kind: "if"; branches: Branch[] };
export type ForNode = Span & {
  kind: "for";
  item: string;
  collection: string[];
  /** ディレクティブ内のコレクション名の位置 */
  collectionSpan: Span;
  separator: string | null;
  body: Node[];
};
export type Node = TextNode | VariableNode | IfNode | ForNode;

export type Template = {
  source: string;
  doc: string | null;
  nodes: Node[];
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const DELIMITERS: ReadonlySet<string> = new Set([",", ")", "(", ";", ":", " ", "\t", "\n", "\r"]);

type Directive =
  | { kind: "if" | "elseif"; expr: string; exprStart: number; inline: string | null }
  | { kind: "else"; inline: string | null }
  | { kind: "for"; item: string; collection: string[]; collectionSpan: Span; separator: string | null }
  | { kind: "end" };

export function parse(source: string): Template {
  const segments = scan(source);
  const doc = extractDoc(segments, source);

  // 制御ディレクティブを境にブロック構造を組み立てる
  type Frame =
    | { kind: "root"; nodes: Node[] }
    | {
        kind: "if";
        start: number;
        branches: Branch[];
        current: { expr: Expr | null; start: number; nodes: Node[] };
        elseSeen: boolean;
      }
    | {
        kind: "for";
        start: number;
        item: string;
        collection: string[];
        collectionSpan: Span;
        separator: string | null;
        nodes: Node[];
      };
  const stack: Frame[] = [{ kind: "root", nodes: [] }];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const currentNodes = (): Node[] => {
    const f = top();
    return f.kind === "if" ? f.current.nodes : f.nodes;
  };

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i] as (typeof segments)[number];
    if (seg.kind === "text") {
      currentNodes().push({ kind: "text", text: source.slice(seg.start, seg.end), start: seg.start, end: seg.end });
      i += 1;
      continue;
    }
    if (seg.sigil === ":") {
      throw new TysqlError("parse/declaration-position", "Declarations must appear at the top of the template.", seg);
    }
    if (seg.sigil !== "%") {
      // 変数。サンプルは次の text セグメントの先頭から消費する
      const next = segments[i + 1];
      if (next?.kind !== "text" || next.start !== seg.end || /\s/.test(source[seg.end] ?? "")) {
        throw new TysqlError(
          "parse/missing-sample",
          `A sample value must directly follow ${describeVariable(seg)}.`,
          seg,
        );
      }
      const node = parseVariable(seg, source);
      currentNodes().push(node);
      // サンプル分だけ text セグメントを前に進める
      if (node.sampleSpan.end >= next.end) {
        i += 2;
      } else {
        segments[i + 1] = { kind: "text", start: node.sampleSpan.end, end: next.end };
        i += 1;
      }
      continue;
    }

    const directive = parseDirective(seg, source);
    switch (directive.kind) {
      case "if": {
        stack.push({
          kind: "if",
          start: seg.start,
          branches: [],
          current: {
            expr: parseExpr(directive.expr, directive.exprStart),
            start: seg.end,
            nodes: inlineNodes(directive.inline, seg),
          },
          elseSeen: false,
        });
        break;
      }
      case "elseif":
      case "else": {
        const f = top();
        if (f.kind !== "if")
          throw new TysqlError("parse/unexpected-directive", `'${directive.kind}' without 'if'.`, seg);
        if (f.elseSeen) throw new TysqlError("parse/else-order", `'${directive.kind}' cannot follow 'else'.`, seg);
        f.branches.push({ expr: f.current.expr, body: f.current.nodes, start: f.current.start, end: seg.start });
        f.current = {
          expr: directive.kind === "elseif" ? parseExpr(directive.expr, directive.exprStart) : null,
          start: seg.end,
          nodes: inlineNodes(directive.inline, seg),
        };
        if (directive.kind === "else") f.elseSeen = true;
        break;
      }
      case "for": {
        if (stack.some((f) => f.kind === "for")) {
          throw new TysqlError("parse/nested-for", "Nested 'for' blocks are not supported.", seg);
        }
        stack.push({
          kind: "for",
          start: seg.start,
          item: directive.item,
          collection: directive.collection,
          collectionSpan: directive.collectionSpan,
          separator: directive.separator,
          nodes: [],
        });
        break;
      }
      case "end": {
        const f = stack.pop() as Frame;
        if (f.kind === "root") throw new TysqlError("parse/unexpected-directive", "'end' without 'if' or 'for'.", seg);
        if (f.kind === "if") {
          f.branches.push({ expr: f.current.expr, body: f.current.nodes, start: f.current.start, end: seg.start });
          currentNodes().push({ kind: "if", branches: f.branches, start: f.start, end: seg.end });
        } else {
          currentNodes().push({
            kind: "for",
            item: f.item,
            collection: f.collection,
            collectionSpan: f.collectionSpan,
            separator: f.separator,
            body: f.nodes,
            start: f.start,
            end: seg.end,
          });
        }
        break;
      }
    }
    i += 1;
  }
  const last = top();
  if (last.kind !== "root") {
    throw new TysqlError("parse/unterminated-block", `Unterminated '${last.kind}' block.`, {
      start: last.start,
      end: source.length,
    });
  }
  return { source, doc, nodes: last.nodes };
}

function describeVariable(seg: CommentSegment): string {
  return `/*${seg.sigil}${seg.body}*/`;
}

/** 先頭の doc 宣言コメントを取り出し、segments から取り除く。 */
function extractDoc(segments: typeof scan extends (s: string) => infer R ? R : never, source: string): string | null {
  let doc: string | null = null;
  while (segments.length > 0) {
    const seg = segments[0] as (typeof segments)[number];
    if (seg.kind === "text") {
      if (source.slice(seg.start, seg.end).trim() !== "") break;
      segments.shift();
      continue;
    }
    if (seg.sigil !== ":") break;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)([\s\S]*)$/.exec(seg.body);
    if (!m) throw new TysqlError("parse/invalid-declaration", "Invalid declaration.", seg);
    const [, name, body] = m as unknown as [string, string, string];
    if (name !== "doc") {
      throw new TysqlError("parse/unknown-declaration", `Unknown declaration '${name}'. Only 'doc' is supported.`, seg);
    }
    if (doc !== null) throw new TysqlError("parse/duplicate-declaration", "Duplicate 'doc' declaration.", seg);
    doc = body.trim();
    segments.shift();
  }
  return doc;
}

function inlineNodes(inline: string | null, seg: CommentSegment): Node[] {
  if (inline === null) return [];
  const start = seg.bodyStart + seg.body.indexOf(inline);
  return [{ kind: "text", text: inline, start, end: start + inline.length }];
}

function parseVariable(seg: CommentSegment, source: string): VariableNode {
  const body = seg.body.trim();
  const parts = body.split(/\s+/);
  const pathText = parts[0] ?? "";
  const modifiers = parts.slice(1);
  if (pathText === "") throw new TysqlError("parse/missing-name", "Variable comment requires a parameter name.", seg);
  if (!PATH.test(pathText)) {
    throw new TysqlError(
      "parse/invalid-name",
      `Invalid parameter name '${pathText}'. Use a JavaScript identifier, optionally dotted.`,
      seg,
    );
  }
  for (const mod of modifiers) {
    if (mod !== "default-to") throw new TysqlError("parse/unknown-modifier", `Unknown modifier '${mod}'.`, seg);
  }
  const defaultTo = modifiers.includes("default-to");
  const kind = seg.sigil === "$" ? "bind" : seg.sigil === "^" ? "literal" : "raw";
  if (defaultTo && kind !== "bind")
    throw new TysqlError("parse/default-to-sigil", "'default-to' is only supported for '$' binds.", seg);

  const sampleStart = seg.end;
  const first = source[sampleStart] as string;
  const collection = kind === "bind" && first === "(";
  const sampleEnd = collection ? consumeParenthesized(source, sampleStart) : consumeToken(source, sampleStart);
  const nameOffset = seg.bodyStart + seg.body.indexOf(pathText);
  return {
    kind,
    path: pathText.split("."),
    name: { start: nameOffset, end: nameOffset + pathText.length },
    sample: source.slice(sampleStart, sampleEnd),
    sampleSpan: { start: sampleStart, end: sampleEnd },
    collection,
    defaultTo,
    start: seg.start,
    end: sampleEnd,
  };
}

function consumeToken(source: string, start: number): number {
  const ch = source[start] as string;
  if (ch === "'") return skipQuoted(source, start, "'", false);
  if ((ch === "E" || ch === "e") && source[start + 1] === "'") return skipQuoted(source, start + 1, "'", true);
  if (ch === "$") {
    const end = skipDollarQuoted(source, start);
    if (end !== undefined) return end;
  }
  let i = start;
  while (i < source.length && !DELIMITERS.has(source[i] as string)) i += 1;
  if (i === start)
    throw new TysqlError("parse/missing-sample", "A sample value must directly follow the variable comment.", {
      start,
      end: start + 1,
    });
  return i;
}

function consumeParenthesized(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      i = skipQuoted(source, i, "'", false);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new TysqlError("parse/unterminated-sample", "Unterminated parenthesized sample.", {
    start,
    end: source.length,
  });
}

function parseDirective(seg: CommentSegment, source: string): Directive {
  const m = /^\s*(if|elseif|else|for|end)\b([\s\S]*)$/.exec(seg.body);
  if (!m) throw new TysqlError("parse/unknown-directive", `Unknown directive '${seg.body.trim()}'.`, seg);
  const name = m[1] as "if" | "elseif" | "else" | "for" | "end";
  const args = (m[2] ?? "").trim();
  switch (name) {
    case "if":
    case "elseif": {
      const arrow = /^([\s\S]*?)\s*=>\s*([\s\S]+)$/.exec(args);
      const expr = arrow ? (arrow[1] as string) : args;
      const inline = arrow ? (arrow[2] as string).trim() : null;
      const exprStart = seg.bodyStart + seg.body.indexOf(expr);
      if (expr.trim() === "") throw new TysqlError("parse/blank-condition", `'${name}' requires a condition.`, seg);
      return { kind: name, expr, exprStart, inline };
    }
    case "else": {
      if (args === "") return { kind: "else", inline: null };
      const arrow = /^=>\s*([\s\S]+)$/.exec(args);
      if (!arrow)
        throw new TysqlError("parse/invalid-directive", "'else' takes no condition. Use '=>' for an inline body.", seg);
      return { kind: "else", inline: (arrow[1] as string).trim() };
    }
    case "for": {
      const f = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+separating\s+([\s\S]+?))?$/.exec(args);
      if (!f)
        throw new TysqlError(
          "parse/invalid-directive",
          "Invalid 'for' directive. Expected 'for <item> in <collection> [separating <sep>]'.",
          seg,
        );
      const item = f[1] as string;
      const collection = f[2] as string;
      if (!IDENT.test(item) || !PATH.test(collection))
        throw new TysqlError("parse/invalid-directive", "Invalid 'for' directive.", seg);
      const collectionAt = seg.bodyStart + seg.body.indexOf(collection, seg.body.indexOf(item) + item.length);
      return {
        kind: "for",
        item,
        collection: collection.split("."),
        collectionSpan: { start: collectionAt, end: collectionAt + collection.length },
        separator: f[3] === undefined ? null : (f[3] as string).trim(),
      };
    }
    case "end":
      if (args !== "") throw new TysqlError("parse/invalid-directive", "'end' takes no arguments.", seg);
      return { kind: "end" };
  }
  // source は診断メッセージのために受け取っているが現状未使用
  void source;
}
