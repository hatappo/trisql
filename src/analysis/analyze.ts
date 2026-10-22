/**
 * テンプレートを Describer で解析し、Params と Row の材料を作る。
 */
import { exprRefs } from "../core/expr.ts";
import type { Node, Template, VariableNode } from "../core/parse.ts";
import { type Canonical, canonical, projectOffset } from "./canonical.ts";
import { type Described, DescribeError, type Describer } from "./describer.ts";
import { loadNotNull, loadTypes, relationOid, tsInputTypeOf, tsTypeOf } from "./pgtypes.ts";

export type Diagnostic = { message: string; start: number; end: number; code: number };

/** 診断コード。content mapper が `tysql<code>` として表示する */
export const DIAG = { parse: 1, describe: 2, config: 3 } as const;

/** パラメータ型の木。葉は型の union、枝はオブジェクト、element があれば配列 */
export type ParamNode = {
  types: Set<string>;
  /** if の条件だけから推した弱い型。types が空のときだけ使う */
  weak: Set<string>;
  required: boolean;
  children: Map<string, ParamNode>;
  element: ParamNode | null;
};

export type Column = { name: string; oid: number; type: string; nullable: boolean };

export type Analysis = {
  params: ParamNode;
  /** null は行を返さない文 */
  columns: Column[] | null;
  /** Describe に失敗し、列が分からない */
  rowUnknown: boolean;
  diagnostics: Diagnostic[];
  canonical: Canonical;
};

export function newParamNode(): ParamNode {
  return { types: new Set(), weak: new Set(), required: false, children: new Map(), element: null };
}

export async function analyze(template: Template, describer: Describer): Promise<Analysis> {
  const canon = canonical(template);
  const diagnostics: Diagnostic[] = [];
  let described: Described | null = null;
  try {
    described = await describer.describe(canon.sql);
  } catch (e) {
    if (!(e instanceof DescribeError)) throw e;
    const start = e.position === null ? 0 : projectOffset(canon, e.position - 1);
    diagnostics.push({
      message: e.hint ? `${e.message} (${e.hint})` : e.message,
      start,
      end: start + 1,
      code: DIAG.describe,
    });
  }

  const oids = new Set<number>();
  if (described) {
    for (const oid of described.params) oids.add(oid);
    for (const c of described.columns ?? []) oids.add(c.oid);
  }
  const types = await loadTypes(describer, oids);

  // パラメータ
  const root = newParamNode();
  const paramTypeByIndex = new Map<number, string>();
  for (const p of canon.placeholders) {
    const oid = described?.params[p.index - 1];
    paramTypeByIndex.set(p.index, oid === undefined || oid === 0 ? sampleType(p.node) : tsInputTypeOf(oid, types));
  }
  const indexByNode = new Map<VariableNode, number>();
  for (const p of canon.placeholders) indexByNode.set(p.node, p.index);
  const bindTypeOf = (node: VariableNode): string => {
    const index = indexByNode.get(node);
    const base = index === undefined ? sampleType(node) : (paramTypeByIndex.get(index) ?? "unknown");
    const at = index === undefined ? null : (canon.placeholders.find((p) => p.index === index)?.at ?? null);
    const extras = at === null ? [] : specialValues(canon.sql.slice(0, at));
    const core = node.collection ? `${wrap(base)}[]` : base;
    return [core, ...extras].join(" | ");
  };
  collectParams(template.nodes, root, new Map(), bindTypeOf);

  // 列
  let columns: Column[] | null = null;
  if (described?.columns) {
    const notNull = await loadNotNull(
      describer,
      described.columns.map((c) => c.table),
    );
    const outerJoin = /\b(LEFT|RIGHT|FULL)\s+(OUTER\s+)?JOIN\b/i.test(canon.sql);
    const driving = outerJoin ? await drivingTable(describer, canon.sql) : null;
    columns = described.columns.map((c) => {
      let nullable = c.table === 0 || !notNull.has(`${c.table}:${c.attnum}`);
      if (outerJoin && c.table !== 0 && c.table !== driving) nullable = true;
      return { name: c.name, oid: c.oid, type: tsTypeOf(c.oid, types), nullable };
    });
  }

  return { params: root, columns, rowUnknown: described === null, diagnostics, canonical: canon };
}

function wrap(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}

/** 文脈から受け付ける特殊値: VALUES / SET では DEFAULT、LIMIT / OFFSET では ALL、LIKE の直後では LIKE ヘルパ */
function specialValues(prefix: string): string[] {
  const extras: string[] = [];
  const clauses = prefix.match(/\b(WHERE|HAVING|SET|VALUES|LIMIT|OFFSET|RETURNING|SELECT|FROM|ORDER BY|GROUP BY)\b/gi);
  const clause = clauses?.at(-1)?.toUpperCase().replace(/\s+/g, " ");
  if (clause === "VALUES" || clause === "SET") extras.push("DefaultValue");
  if (clause === "LIMIT" || clause === "OFFSET") extras.push("AllValue");
  if (/\bI?LIKE\s*$/i.test(prefix)) extras.push("LikePattern");
  return extras;
}

/** Describe が使えないときの、サンプルリテラルからの型 */
export function sampleType(node: VariableNode): string {
  let sample = node.sample;
  if (node.collection) {
    const inner = sample.slice(1, -1).trim();
    sample = inner.split(",")[0]?.trim() ?? "";
  }
  if (/^'/.test(sample) || /^E'/i.test(sample) || /^\$/.test(sample)) return "string";
  if (/^-?\d+(\.\d+)?$/.test(sample)) return "number";
  if (/^(true|false)$/i.test(sample)) return "boolean";
  if (/^null$/i.test(sample)) return "null";
  return "unknown";
}

type Scope = Map<string, ParamNode>;

function collectParams(
  nodes: Node[],
  root: ParamNode,
  scope: Scope,
  bindTypeOf: (node: VariableNode) => string,
  /** if の分岐の中: 分岐が選ばれたときだけ要るので必須にしない */
  conditional = false,
): void {
  const nodeFor = (path: string[]): ParamNode => {
    const head = path[0] as string;
    const base = scope.get(head);
    return base ? ensure(base, path.slice(1)) : ensure(root, path);
  };
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        break;
      case "bind": {
        const target = nodeFor(node.path);
        target.types.add(bindTypeOf(node));
        if (!node.defaultTo && !conditional) target.required = true;
        break;
      }
      case "literal": {
        const target = nodeFor(node.path);
        target.types.add(sampleType(node) === "number" ? "number" : "string");
        if (!conditional) target.required = true;
        break;
      }
      case "raw": {
        const target = nodeFor(node.path);
        target.types.add("string");
        if (!conditional) target.required = true;
        break;
      }
      case "if": {
        for (const branch of node.branches) {
          if (branch.expr) {
            for (const path of exprRefs(branch.expr)) {
              const target = nodeFor(path);
              target.weak.add(isBareRef(branch.expr, path) ? "boolean | null | undefined" : "unknown");
            }
          }
          collectParams(branch.body, root, scope, bindTypeOf, true);
        }
        break;
      }
      case "for": {
        const target = nodeFor(node.collection);
        if (!conditional) target.required = true;
        target.element ??= newParamNode();
        const inner: Scope = new Map(scope);
        inner.set(node.item, target.element);
        collectParams(node.body, root, inner, bindTypeOf, conditional);
        break;
      }
    }
  }
}

/** 式の中でこの path が裸の真偽判定として使われているか（比較のオペランドではなく） */
function isBareRef(expr: import("../core/expr.ts").Expr, path: string[]): boolean {
  switch (expr.kind) {
    case "ref":
      return expr.path.join(".") === path.join(".");
    case "compare":
      return false;
    case "and":
    case "or":
      return isBareRef(expr.left, path) || isBareRef(expr.right, path);
  }
}

function ensure(node: ParamNode, path: string[]): ParamNode {
  let current = node;
  for (const segment of path) {
    let child = current.children.get(segment);
    if (!child) {
      child = newParamNode();
      current.children.set(segment, child);
    }
    current = child;
  }
  return current;
}

async function drivingTable(describer: Describer, sql: string): Promise<number | null> {
  const m =
    /\bFROM\s+(?:ONLY\s+)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)/i.exec(sql);
  if (!m) return null;
  return relationOid(describer, m[1] as string);
}
