/**
 * `if` / `elseif` の条件式。
 *
 *   expr   := and ( "or" and )*
 *   and    := group ( "and" group )*
 *   group  := "(" expr ")" | comparison
 *   comparison := operand ( op operand )?
 *   operand := identifier ( "." identifier )*
 *
 * オペランドはパラメータ参照のみ。裸の識別子は真偽判定。
 * 偽は null / undefined / false のみ。比較は === による。
 */
import { TysqlError } from "./errors.ts";

export type Expr =
  | { kind: "ref"; path: string[] }
  | { kind: "compare"; op: CompareOp; left: ExprRef; right: ExprRef }
  | { kind: "and"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr };

export type ExprRef = { kind: "ref"; path: string[] };
export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

type Token =
  | { type: "lparen" | "rparen" | "and" | "or"; text: string }
  | { type: "op"; text: CompareOp }
  | { type: "ident"; text: string }
  | { type: "end"; text: "" };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

function tokenize(expression: string, offset: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", text: ch });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", text: ch });
      i += 1;
      continue;
    }
    const rest = expression.slice(i);
    const op = /^(<=|>=|!=|=|<|>)/.exec(rest);
    if (op) {
      tokens.push({ type: "op", text: op[0] as CompareOp });
      i += op[0].length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) {
      const text = ident[0];
      if (text === "and" || text === "or") tokens.push({ type: text, text });
      else tokens.push({ type: "ident", text });
      i += text.length;
      continue;
    }
    throw new TysqlError("expr/unexpected-token", `Unexpected character '${ch}' in condition.`, {
      start: offset + i,
      end: offset + i + 1,
      details: { expression },
    });
  }
  return tokens;
}

export function parseExpr(expression: string, offset = 0): Expr {
  const trimmed = expression.trim();
  if (trimmed === "") {
    throw new TysqlError("expr/blank", "Condition must not be blank.", {
      start: offset,
      end: offset + expression.length,
    });
  }
  const tokens = tokenize(expression, offset);
  let pos = 0;
  const peek = (): Token => tokens[pos] ?? { type: "end", text: "" };
  const fail = (message: string): never => {
    throw new TysqlError("expr/syntax", message, {
      start: offset,
      end: offset + expression.length,
      details: { expression },
    });
  };

  const operand = (): ExprRef => {
    const t = peek();
    if (t.type !== "ident") return fail(`Expected a parameter name, got '${t.text || "end of condition"}'.`);
    pos += 1;
    return { kind: "ref", path: t.text.split(".") };
  };
  const comparison = (): Expr => {
    const left = operand();
    const t = peek();
    if (t.type === "op") {
      pos += 1;
      const right = operand();
      return { kind: "compare", op: t.text, left, right };
    }
    return left;
  };
  const group = (): Expr => {
    if (peek().type === "lparen") {
      pos += 1;
      const inner = or();
      if (peek().type !== "rparen") fail("Expected ')' in condition.");
      pos += 1;
      return inner;
    }
    return comparison();
  };
  const and = (): Expr => {
    let left = group();
    while (peek().type === "and") {
      pos += 1;
      left = { kind: "and", left, right: group() };
    }
    return left;
  };
  const or = (): Expr => {
    let left = and();
    while (peek().type === "or") {
      pos += 1;
      left = { kind: "or", left, right: and() };
    }
    return left;
  };

  const ast = or();
  if (peek().type !== "end") fail(`Unexpected '${peek().text}' in condition.`);
  return ast;
}

export function isTruthy(value: unknown): boolean {
  return !(value === null || value === undefined || value === false);
}

export function evaluateExpr(expr: Expr, resolve: (path: string[]) => unknown): boolean {
  switch (expr.kind) {
    case "ref":
      return isTruthy(resolve(expr.path));
    case "and":
      return evaluateExpr(expr.left, resolve) && evaluateExpr(expr.right, resolve);
    case "or":
      return evaluateExpr(expr.left, resolve) || evaluateExpr(expr.right, resolve);
    case "compare": {
      const left = resolve(expr.left.path);
      const right = resolve(expr.right.path);
      switch (expr.op) {
        case "=":
          return left === right;
        case "!=":
          return left !== right;
        default: {
          if (left === null || left === undefined || right === null || right === undefined) {
            throw new TysqlError(
              "expr/null-ordering",
              `Ordering comparison '${expr.op}' does not accept null or undefined.`,
              {
                details: { left: expr.left.path.join("."), right: expr.right.path.join(".") },
              },
            );
          }
          const l = left as number | string | bigint;
          const r = right as number | string | bigint;
          switch (expr.op) {
            case "<":
              return l < r;
            case "<=":
              return l <= r;
            case ">":
              return l > r;
            case ">=":
              return l >= r;
          }
        }
      }
    }
  }
}

/** 式が参照するパラメータの path をすべて返す（型付けに使う）。 */
export function exprRefs(expr: Expr): string[][] {
  switch (expr.kind) {
    case "ref":
      return [expr.path];
    case "compare":
      return [expr.left.path, expr.right.path];
    case "and":
    case "or":
      return [...exprRefs(expr.left), ...exprRefs(expr.right)];
  }
}
