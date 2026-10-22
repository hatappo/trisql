/**
 * 構文木（libpg-query、PostgreSQL 本体のパーサの wasm ビルド）による解析。
 *
 * パッケージは optional peer。入っていなければ null を返し、呼び出し側は保守的な規則に戻る。
 * ここで導くのは「外部結合の null 側にあるリレーション」だけで、迷う場合は nullable に倒す。
 */

type Node = Record<string, unknown>;

export type Parser = { parse(sql: string): Node };

let loading: Promise<Parser | null> | undefined;

/** libpg-query を読み込む。未インストールなら null */
export function loadParser(): Promise<Parser | null> {
  loading ??= (async () => {
    try {
      const mod = (await import("libpg-query")) as unknown as {
        loadModule(): Promise<void>;
        parseSync(sql: string): Node;
      };
      await mod.loadModule();
      return { parse: (sql) => mod.parseSync(sql) };
    } catch {
      return null;
    }
  })();
  return loading;
}

export type Statement = { kind: "select" | "insert" | "update" | "delete" | "other"; node: Node };

/** 1 文の構文木。パースできなければ null */
export function statementOf(parser: Parser, sql: string): Statement | null {
  let result: Node;
  try {
    result = parser.parse(sql);
  } catch {
    return null;
  }
  const stmts = result.stmts as { stmt: Node }[] | undefined;
  const stmt = stmts?.[0]?.stmt;
  if (!stmt || stmts?.length !== 1) return null;
  if (stmt.SelectStmt) return { kind: "select", node: stmt.SelectStmt as Node };
  if (stmt.InsertStmt) return { kind: "insert", node: stmt.InsertStmt as Node };
  if (stmt.UpdateStmt) return { kind: "update", node: stmt.UpdateStmt as Node };
  if (stmt.DeleteStmt) return { kind: "delete", node: stmt.DeleteStmt as Node };
  return { kind: "other", node: stmt };
}

export type Relations = {
  /** 外部結合の null 側（またはその内側）にあるリレーション名 */
  nullable: Set<string>;
  /** 非 null 側だけに現れたリレーション名 */
  solid: Set<string>;
};

/**
 * 文中のリレーションを、外部結合の null 側にあるかどうかで分類する。
 * 同じ名前が両側に現れたら（自己結合など）nullable に入れる。
 */
export function classifyRelations(statement: Statement): Relations {
  const out: Relations = { nullable: new Set(), solid: new Set() };
  const ctes = new Map<string, Node>();
  const n = statement.node;
  collectCtes(n.withClause as Node | undefined, ctes);
  switch (statement.kind) {
    case "select":
      walkSelect(n, false, out, ctes);
      break;
    case "update":
      walkItem({ RangeVar: n.relation }, false, out, ctes);
      for (const item of (n.fromClause as Node[] | undefined) ?? []) walkItem(item, false, out, ctes);
      break;
    case "delete":
      walkItem({ RangeVar: n.relation }, false, out, ctes);
      for (const item of (n.usingClause as Node[] | undefined) ?? []) walkItem(item, false, out, ctes);
      break;
    case "insert":
      if (n.selectStmt) walkSelect((n.selectStmt as Node).SelectStmt as Node, false, out, ctes);
      break;
    case "other":
      break;
  }
  for (const name of out.nullable) out.solid.delete(name);
  return out;
}

function collectCtes(withClause: Node | undefined, ctes: Map<string, Node>): void {
  for (const item of (withClause?.ctes as Node[] | undefined) ?? []) {
    const cte = item.CommonTableExpr as Node | undefined;
    if (cte?.ctename && cte.ctequery) ctes.set(cte.ctename as string, cte.ctequery as Node);
  }
}

function walkSelect(select: Node | undefined, nullable: boolean, out: Relations, ctes: Map<string, Node>): void {
  if (!select) return;
  const inner = new Map(ctes);
  collectCtes(select.withClause as Node | undefined, inner);
  if (select.larg || select.rarg) {
    walkSelect((select.larg as Node | undefined)?.SelectStmt as Node | undefined, nullable, out, inner);
    walkSelect((select.rarg as Node | undefined)?.SelectStmt as Node | undefined, nullable, out, inner);
  }
  for (const item of (select.fromClause as Node[] | undefined) ?? []) walkItem(item, nullable, out, inner);
}

function walkItem(item: Node, nullable: boolean, out: Relations, ctes: Map<string, Node>): void {
  if (item.RangeVar) {
    const rv = item.RangeVar as Node;
    const name = rv.relname as string;
    const cte = ctes.get(name);
    if (cte && !rv.schemaname) {
      // CTE 参照: 中のリレーションは参照された側の null 性を引き継ぐ
      walkStmtNode(cte, nullable, out, ctes);
      return;
    }
    (nullable ? out.nullable : out.solid).add(name);
    return;
  }
  if (item.JoinExpr) {
    const join = item.JoinExpr as Node;
    const type = join.jointype as string;
    const leftNullable = nullable || type === "JOIN_RIGHT" || type === "JOIN_FULL";
    const rightNullable = nullable || type === "JOIN_LEFT" || type === "JOIN_FULL";
    walkItem(join.larg as Node, leftNullable, out, ctes);
    walkItem(join.rarg as Node, rightNullable, out, ctes);
    return;
  }
  if (item.RangeSubselect) {
    walkStmtNode((item.RangeSubselect as Node).subquery as Node, nullable, out, ctes);
    return;
  }
  // RangeFunction、RangeTableSample など: 列の由来テーブルは Describe が 0 を返すので何もしない
}

function walkStmtNode(stmt: Node, nullable: boolean, out: Relations, ctes: Map<string, Node>): void {
  if (stmt.SelectStmt) walkSelect(stmt.SelectStmt as Node, nullable, out, ctes);
}

// --- cardinality ---------------------------------------------------------------

export type Cardinality = "one" | "maybeOne" | "many" | "none";

/** リレーション名（`schema.name` または `name`）からユニークキーの列名の組を返す */
export type UniqueKeys = (relation: string) => Promise<string[][]>;

const AGGREGATES = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "bool_and",
  "bool_or",
  "every",
  "array_agg",
  "string_agg",
  "json_agg",
  "jsonb_agg",
  "json_object_agg",
  "jsonb_object_agg",
  "bit_and",
  "bit_or",
  "xmlagg",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
]);

/**
 * 文が返す行数。迷ったら many（または DML なら none）に倒す。
 *
 * - RETURNING のない INSERT / UPDATE / DELETE は none
 * - 1 行の VALUES を持つ INSERT ... RETURNING は one（ON CONFLICT DO NOTHING なら maybeOne）
 * - LIMIT 1 は maybeOne
 * - FROM のない SELECT は one（WHERE があれば maybeOne）
 * - GROUP BY のない集約だけの SELECT は one（HAVING があれば maybeOne）
 * - 単一テーブルの SELECT / UPDATE / DELETE で、WHERE がユニークキーの全列を `=` で固定していれば maybeOne
 */
export async function cardinalityOf(statement: Statement, uniqueKeys: UniqueKeys): Promise<Cardinality> {
  const n = statement.node;
  switch (statement.kind) {
    case "insert": {
      if (!n.returningClause) return "none";
      const select = (n.selectStmt as Node | undefined)?.SelectStmt as Node | undefined;
      const values = select?.valuesLists as Node[] | undefined;
      if (values?.length !== 1) return "many";
      const conflict = n.onConflictClause as Node | undefined;
      if (conflict && conflict.action === "ONCONFLICT_NOTHING") return "maybeOne";
      return "one";
    }
    case "update":
    case "delete": {
      if (!n.returningClause) return "none";
      const relation = n.relation as Node;
      return (await keyBound(relation, n.whereClause as Node | undefined, uniqueKeys)) ? "maybeOne" : "many";
    }
    case "select":
      return selectCardinality(n, uniqueKeys);
    case "other":
      return "many";
  }
}

async function selectCardinality(select: Node, uniqueKeys: UniqueKeys): Promise<Cardinality> {
  if (select.op !== "SETOP_NONE") return "many";
  if (isLimitOne(select.limitCount as Node | undefined)) return "maybeOne";
  const from = (select.fromClause as Node[] | undefined) ?? [];
  const where = select.whereClause as Node | undefined;
  if (from.length === 0 && !select.valuesLists) return where ? "maybeOne" : "one";
  if (!select.groupClause && !select.distinctClause && onlyAggregates(select.targetList as Node[] | undefined)) {
    return select.havingClause ? "maybeOne" : "one";
  }
  const single = from.length === 1 ? ((from[0] as Node).RangeVar as Node | undefined) : undefined;
  if (single && (await keyBound(single, where, uniqueKeys))) return "maybeOne";
  return "many";
}

function isLimitOne(limit: Node | undefined): boolean {
  const ival = ((limit?.A_Const as Node | undefined)?.ival as Node | undefined)?.ival;
  return ival === 1 || ival === 0;
}

function onlyAggregates(targets: Node[] | undefined): boolean {
  if (!targets || targets.length === 0) return false;
  return targets.every((t) => isAggregate(((t.ResTarget as Node | undefined)?.val as Node | undefined) ?? {}));
}

function isAggregate(expr: Node): boolean {
  if (expr.TypeCast) return isAggregate((expr.TypeCast as Node).arg as Node);
  const call = expr.FuncCall as Node | undefined;
  if (!call) return false;
  if (call.agg_star) return true;
  const names = (call.funcname as Node[]).map((f) => (f.String as Node).sval as string);
  return AGGREGATES.has(names[names.length - 1] as string);
}

/** WHERE がこのリレーションのユニークキーの全列を `=` で固定しているか */
async function keyBound(relation: Node, where: Node | undefined, uniqueKeys: UniqueKeys): Promise<boolean> {
  if (!where) return false;
  const relname = relation.relname as string;
  const qualifiers = new Set<string>([
    relname,
    ((relation.alias as Node | undefined)?.aliasname as string | undefined) ?? relname,
  ]);
  const bound = new Set<string>();
  for (const expr of andTerms(where)) {
    const column = equalityColumn(expr, qualifiers);
    if (column) bound.add(column);
  }
  if (bound.size === 0) return false;
  const schema = relation.schemaname as string | undefined;
  const keys = await uniqueKeys(schema ? `${schema}.${relname}` : relname);
  return keys.some((key) => key.length > 0 && key.every((c) => bound.has(c)));
}

function andTerms(expr: Node): Node[] {
  const bool = expr.BoolExpr as Node | undefined;
  if (bool && bool.boolop === "AND_EXPR") return (bool.args as Node[]).flatMap(andTerms);
  return [expr];
}

/** `col = <param | const>`（または逆順）なら列名。修飾子が別のリレーションなら null */
function equalityColumn(expr: Node, qualifiers: Set<string>): string | null {
  const a = expr.A_Expr as Node | undefined;
  if (a?.kind !== "AEXPR_OP") return null;
  const op = ((a.name as Node[])[0]?.String as Node | undefined)?.sval;
  if (op !== "=") return null;
  for (const [side, other] of [
    [a.lexpr, a.rexpr],
    [a.rexpr, a.lexpr],
  ] as [Node, Node][]) {
    const column = columnOf(side, qualifiers);
    if (column && isValue(other)) return column;
  }
  return null;
}

function columnOf(expr: Node, qualifiers: Set<string>): string | null {
  const ref = expr.ColumnRef as Node | undefined;
  if (!ref) return null;
  const fields = (ref.fields as Node[]).map((f) => (f.String as Node | undefined)?.sval as string | undefined);
  if (fields.some((f) => f === undefined)) return null;
  if (fields.length === 1) return fields[0] as string;
  if (fields.length === 2 && qualifiers.has(fields[0] as string)) return fields[1] as string;
  return null;
}

function isValue(expr: Node): boolean {
  if (expr.TypeCast) return isValue((expr.TypeCast as Node).arg as Node);
  return expr.ParamRef !== undefined || expr.A_Const !== undefined;
}
