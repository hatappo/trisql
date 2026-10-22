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
