/**
 * 解析結果から TypeScript の型テキストと、content mapper が tsc に渡す仮想モジュールを作る。
 */
import type { Analysis, Column, ParamNode } from "./analyze.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function key(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

export function renderParams(root: ParamNode): string {
  if (root.children.size === 0) return "Record<never, never>";
  return renderObject(root);
}

function renderObject(node: ParamNode): string {
  const fields = [...node.children].map(
    ([name, child]) => `${key(name)}${isOptional(child) ? "?" : ""}: ${renderNode(child)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

function isOptional(node: ParamNode): boolean {
  if (node.required) return false;
  if (node.children.size > 0) return [...node.children.values()].every(isOptional);
  return true;
}

function renderNode(node: ParamNode): string {
  const parts: string[] = [];
  if (node.element) {
    const element = node.element;
    const elementType = renderNode(element);
    parts.push(`Array<${elementType}>`);
    // 要素が { name, value } だけなら Record 形式も受け付ける
    const keys = [...element.children.keys()].sort();
    const value = element.children.get("value");
    if (keys.join(",") === "name,value" && value) parts.push(`Record<string, ${renderNode(value)}>`);
  }
  if (node.children.size > 0) parts.push(renderObject(node));
  const types = [...(node.types.size > 0 ? node.types : node.weak)].flatMap((t) => t.split(" | "));
  for (const t of types) if (!parts.includes(t)) parts.push(t);
  if (parts.length === 0) return "unknown";
  return parts.join(" | ");
}

export function renderRow(analysis: Analysis): string {
  if (analysis.rowUnknown) return "unknown";
  if (analysis.columns === null) return "never";
  if (analysis.columns.length === 0) return "Record<never, never>";
  return `{ ${analysis.columns.map(renderColumn).join("; ")} }`;
}

function renderColumn(c: Column): string {
  return `${key(c.name)}: ${c.type}${c.nullable ? " | null" : ""}`;
}

export function virtualModule(analysis: Analysis, raw: string, doc: string | null): string {
  const params = renderParams(analysis.params);
  const row = renderRow(analysis);
  const jsdoc = doc === null ? "" : `/** ${doc.replace(/\*\//g, "* /")} */\n`;
  return [
    `import type { AllValue, DefaultValue, LikePattern, Query } from "tysql";`,
    `export type Params = ${params};`,
    `export type Row = ${row};`,
    `export declare const raw: ${JSON.stringify(raw)};`,
    `${jsdoc}declare const query: Query<Params, Row>;`,
    `export default query;`,
    `export type { AllValue, DefaultValue, LikePattern };`,
    ``,
  ].join("\n");
}
