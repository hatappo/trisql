/**
 * テンプレートとパラメータから SQL とバインド値を作る。
 */
import { TysqlError } from "./errors.ts";
import { evaluateExpr } from "./expr.ts";
import type { Node, Template, VariableNode } from "./parse.ts";
import { ALL, DEFAULT, isLikePattern } from "./values.ts";

export type Rendered = { sql: string; params: unknown[] };
export type Params = Readonly<Record<string, unknown>>;

const MISSING: unique symbol = Symbol("missing");

type State = {
  out: string;
  params: unknown[];
  /** ループ外のスカラーバインドで同じ path に同じ `$n` を使うための表 */
  placeholders: Map<string, number>;
  loopDepth: number;
  /** 直前のブロックが空だったので、続く AND/OR または直前の WHERE/HAVING を除去する */
  skip: boolean;
};

export function render(template: Template, params: Params): Rendered {
  const state: State = { out: "", params: [], placeholders: new Map(), loopDepth: 0, skip: false };
  renderNodes(template.nodes, params, state);
  if (state.skip) state.out = removeTrailingClauseKeyword(state.out);
  return { sql: state.out.trim(), params: state.params };
}

function renderNodes(nodes: Node[], params: Params, state: State): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text": {
        let text = node.text;
        if (state.skip) {
          const stripped = stripLeadingOperator(text);
          if (stripped !== null) text = stripped;
          else state.out = removeTrailingClauseKeyword(state.out);
          state.skip = false;
        }
        state.out += text;
        break;
      }
      case "bind":
      case "literal":
      case "raw": {
        if (state.skip) {
          state.out = removeTrailingClauseKeyword(state.out);
          state.skip = false;
        }
        renderVariable(node, params, state);
        break;
      }
      case "if": {
        if (state.skip) {
          state.out = removeTrailingClauseKeyword(state.out);
          state.skip = false;
        }
        const branch = node.branches.find(
          (b) => b.expr === null || evaluateExpr(b.expr, (path) => lookupOrUndefined(params, path)),
        );
        if (!branch) {
          state.skip = true;
          break;
        }
        const body = renderFragment(branch.body, params, state);
        state.out += normalizeForContext(state.out, body);
        break;
      }
      case "for": {
        const items = lookupItems(params, node.collection);
        if (items.length === 0) {
          if (!state.skip) {
            if (/\bSET\s*$/i.test(state.out))
              throw new TysqlError("render/empty-set", "Empty 'for' block is not allowed in SET clause.", node);
            if (/\bVALUES\s*$/i.test(state.out))
              throw new TysqlError("render/empty-values", "Empty 'for' block is not allowed in VALUES clause.", node);
          }
          state.skip = true;
          break;
        }
        if (state.skip) {
          state.out = removeTrailingClauseKeyword(state.out);
          state.skip = false;
        }
        state.loopDepth += 1;
        items.forEach((item, index) => {
          const scoped: Params = { ...params, [node.item]: item };
          let fragment = renderFragment(node.body, scoped, state);
          if (node.separator !== null) fragment = fragment.replace(/\r?\n$/, "");
          fragment = normalizeForContext(state.out, fragment);
          if (node.separator !== null && index > 0) state.out += node.separator;
          state.out += fragment;
        });
        state.loopDepth -= 1;
        break;
      }
    }
  }
}

/** 子ノード列を描画し、SQL 断片だけを返す。バインド値は state.params に積まれる。 */
function renderFragment(nodes: Node[], params: Params, state: State): string {
  const saved = state.out;
  const savedSkip = state.skip;
  state.out = "";
  state.skip = false;
  renderNodes(nodes, params, state);
  if (state.skip) state.out = removeTrailingClauseKeyword(state.out);
  const fragment = state.out;
  state.out = saved;
  state.skip = savedSkip;
  return fragment;
}

function normalizeForContext(out: string, fragment: string): string {
  return out.endsWith("\n") && fragment.startsWith("\n") ? fragment.slice(1) : fragment;
}

function stripLeadingOperator(text: string): string | null {
  const m = /^[ \t\r\n]*(AND|OR)[ \t\r\n]*/i.exec(text);
  return m ? text.slice(m[0].length) : null;
}

export function removeTrailingClauseKeyword(sql: string): string {
  const m = /(^|[\s(])(WHERE|HAVING)[ \t\r\n]*$/i.exec(sql);
  if (!m) return sql;
  return sql.slice(0, m.index + (m[1] as string).length);
}

function renderVariable(node: VariableNode, params: Params, state: State): void {
  const pathText = node.path.join(".");
  const value = lookup(params, node.path);
  switch (node.kind) {
    case "bind": {
      if (value === MISSING) {
        if (node.defaultTo) {
          state.out += node.sample;
          return;
        }
        throw missing(node, pathText);
      }
      if (node.collection) {
        if (!Array.isArray(value))
          throw new TysqlError("render/collection-type", `Collection binding '${pathText}' requires an array.`, {
            ...node,
            details: { value },
          });
        if (value.length === 0)
          throw new TysqlError(
            "render/collection-empty",
            `Collection binding '${pathText}' does not allow an empty array.`,
            node,
          );
        for (const element of value) {
          if (element === DEFAULT || element === ALL || isLikePattern(element)) {
            throw new TysqlError(
              "render/collection-element",
              `DEFAULT, ALL and LIKE helpers are not allowed inside collection binding '${pathText}'.`,
              node,
            );
          }
        }
        state.out += `(${value.map((element) => placeholder(state, null, element)).join(", ")})`;
        return;
      }
      if (value === DEFAULT) {
        state.out += "DEFAULT";
        return;
      }
      if (value === ALL) {
        state.out += "ALL";
        return;
      }
      if (isLikePattern(value)) {
        state.out += placeholder(state, null, value.toPattern());
        return;
      }
      state.out += placeholder(state, state.loopDepth === 0 ? pathText : null, value);
      return;
    }
    case "literal": {
      if (value === MISSING) throw missing(node, pathText);
      if (typeof value === "string") {
        state.out += `'${value.replaceAll("'", "''")}'`;
        return;
      }
      if (typeof value === "number" || typeof value === "bigint") {
        state.out += String(value);
        return;
      }
      throw new TysqlError("render/literal-type", `Literal '${pathText}' must be a string or a number.`, {
        ...node,
        details: { value },
      });
    }
    case "raw": {
      if (value === MISSING) throw missing(node, pathText);
      if (typeof value !== "string")
        throw new TysqlError("render/raw-type", `Raw '${pathText}' must be a string.`, { ...node, details: { value } });
      state.out += value;
      return;
    }
  }
}

function placeholder(state: State, reuseKey: string | null, value: unknown): string {
  if (reuseKey !== null) {
    const existing = state.placeholders.get(reuseKey);
    if (existing !== undefined) return `$${existing}`;
  }
  state.params.push(value);
  const index = state.params.length;
  if (reuseKey !== null) state.placeholders.set(reuseKey, index);
  return `$${index}`;
}

function missing(node: VariableNode, pathText: string): TysqlError {
  return new TysqlError("render/missing-parameter", `Missing query parameter: ${pathText}`, {
    start: node.start,
    end: node.end,
    details: { parameter: pathText },
  });
}

function lookup(params: Params, path: string[]): unknown | typeof MISSING {
  let current: unknown = params;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return MISSING;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return MISSING;
  }
  return current;
}

function lookupOrUndefined(params: Params, path: string[]): unknown {
  const value = lookup(params, path);
  return value === MISSING ? undefined : value;
}

function lookupItems(params: Params, path: string[]): unknown[] {
  const pathText = path.join(".");
  const value = lookup(params, path);
  if (value === MISSING)
    throw new TysqlError("render/missing-parameter", `Missing query parameter: ${pathText}`, {
      details: { parameter: pathText },
    });
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([name, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TysqlError("render/for-key", `Key '${name}' of '${pathText}' is not a valid SQL identifier.`, {
          details: { parameter: pathText, key: name },
        });
      }
      return { name, value: v };
    });
  }
  throw new TysqlError("render/for-type", `'${pathText}' must be an array or an object for a 'for' block.`, {
    details: { parameter: pathText, value },
  });
}
