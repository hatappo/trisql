/**
 * 解析結果から TypeScript の型テキストと、content mapper が tsc に渡す仮想モジュールを作る。
 *
 * 仮想モジュールの各キー（Params のプロパティ名、Row の列名）は、テンプレート上の名前の位置に
 * Alias として対応づける。それ以外の部分は文全体に Atom として対応づける。
 */
import type { Span } from "../core/parse.ts";
import type { Analysis, ParamNode } from "./analyze.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** TypeScript の span map の種別と機能 */
const VERBATIM_OR_ATOM = 1;
const ALIAS = 2;
const HOVER = 1;
const DEFINITION = 8;
const TYPE_DEFINITION = 16;
const IMPLEMENTATION = 32;

export function key(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

/** 仮想テキストを書きながら、キーの位置を記録するビルダー */
class Builder {
  text = "";
  readonly keys: { start: number; length: number; span: Span }[] = [];
  write(s: string): void {
    this.text += s;
  }
  key(name: string, span: Span | null): void {
    const written = key(name);
    if (span) this.keys.push({ start: this.text.length, length: written.length, span });
    this.text += written;
  }
}

export function renderParams(root: ParamNode): string {
  const b = new Builder();
  writeParams(b, root);
  return b.text;
}

function writeParams(b: Builder, root: ParamNode): void {
  if (root.children.size === 0) {
    b.write("Record<never, never>");
    return;
  }
  writeObject(b, root);
}

function writeObject(b: Builder, node: ParamNode): void {
  b.write("{ ");
  let first = true;
  for (const [name, child] of node.children) {
    if (!first) b.write("; ");
    first = false;
    b.key(name, child.span);
    b.write(isOptional(child) ? "?: " : ": ");
    writeNode(b, child);
  }
  b.write(" }");
}

function isOptional(node: ParamNode): boolean {
  if (node.required) return false;
  if (node.children.size > 0) return [...node.children.values()].every(isOptional);
  return true;
}

function writeNode(b: Builder, node: ParamNode): void {
  let parts = 0;
  const sep = () => {
    if (parts > 0) b.write(" | ");
    parts += 1;
  };
  if (node.element) {
    const element = node.element;
    sep();
    b.write("Array<");
    writeNode(b, element);
    b.write(">");
    // 要素が { name, value } だけなら Record 形式も受け付ける
    const keys = [...element.children.keys()].sort();
    const value = element.children.get("value");
    if (keys.join(",") === "name,value" && value) {
      sep();
      b.write("Record<string, ");
      writeNode(b, value);
      b.write(">");
    }
  }
  if (node.children.size > 0) {
    sep();
    writeObject(b, node);
  }
  const seen = new Set<string>();
  for (const t of [...(node.types.size > 0 ? node.types : node.weak)].flatMap((t) => t.split(" | "))) {
    if (seen.has(t)) continue;
    seen.add(t);
    sep();
    b.write(t);
  }
  if (parts === 0) b.write("unknown");
}

export function renderRow(analysis: Analysis, source = ""): string {
  const b = new Builder();
  writeRow(b, analysis, source);
  return b.text;
}

function writeRow(b: Builder, analysis: Analysis, source: string): void {
  if (analysis.rowUnknown) {
    b.write("unknown");
    return;
  }
  if (analysis.columns === null) {
    b.write("never");
    return;
  }
  if (analysis.columns.length === 0) {
    b.write("Record<never, never>");
    return;
  }
  b.write("{ ");
  analysis.columns.forEach((c, i) => {
    if (i > 0) b.write("; ");
    b.key(c.name, columnSpan(source, c.name));
    b.write(`: ${c.type}${c.nullable ? " | null" : ""}`);
  });
  b.write(" }");
}

/** SELECT リスト（最初の SELECT から FROM まで）にある列名の位置。見つからなければ null */
export function columnSpan(source: string, name: string): Span | null {
  if (!IDENT.test(name)) return null;
  const select = /\bSELECT\b/i.exec(source);
  if (!select) return null;
  const from = /\bFROM\b/i.exec(source.slice(select.index));
  const region = source.slice(select.index, from ? select.index + from.index : undefined);
  const m = new RegExp(`(^|[^A-Za-z0-9_"])(${name})(?![A-Za-z0-9_])`).exec(region);
  if (!m) return null;
  const start = select.index + m.index + (m[1] as string).length;
  return { start, end: start + name.length };
}

export type VirtualModule = { text: string; mappings: number[][] };

export function virtualModule(analysis: Analysis, raw: string, doc: string | null): VirtualModule {
  const b = new Builder();
  b.write(`import type { AllValue, DefaultValue, LikePattern, Query } from "tysql";\n`);
  b.write("export type Params = ");
  writeParams(b, analysis.params);
  b.write(";\nexport type Row = ");
  writeRow(b, analysis, raw);
  b.write(";\n");
  b.write(`export declare const raw: ${JSON.stringify(raw)};\n`);
  if (doc !== null) b.write(`/** ${doc.replace(/\*\//g, "* /")} */\n`);
  b.write("declare const query: Query<Params, Row>;\nexport default query;\n");
  b.write("export type { AllValue, DefaultValue, LikePattern };\n");
  return { text: b.text, mappings: mappings(b, raw) };
}

/**
 * 仮想テキスト全体を文全体への Atom で埋め、キーの位置だけ Alias で元の名前に対応づける。
 * 仮想側の区間は順序どおりで重ならないようにする（元側は重なってよい）。
 */
function mappings(b: Builder, raw: string): number[][] {
  let start = 0;
  let end = raw.length;
  while (start < end && /\s/.test(raw[start] as string)) start++;
  while (end > start && /\s/.test(raw[end - 1] as string)) end--;
  const statement = (from: number, to: number): number[] => [
    from,
    to - from,
    start,
    end - start,
    VERBATIM_OR_ATOM,
    DEFINITION | TYPE_DEFINITION | IMPLEMENTATION,
  ];
  const out: number[][] = [];
  let cursor = 0;
  for (const k of [...b.keys].sort((x, y) => x.start - y.start)) {
    if (k.start > cursor) out.push(statement(cursor, k.start));
    out.push([k.start, k.length, k.span.start, k.span.end - k.span.start, ALIAS, HOVER | DEFINITION | TYPE_DEFINITION]);
    cursor = k.start + k.length;
  }
  if (cursor < b.text.length) out.push(statement(cursor, b.text.length));
  return out;
}
