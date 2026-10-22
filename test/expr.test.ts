import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateExpr, parseExpr } from "../src/core/expr.ts";

const evaluate = (expr: string, params: Record<string, unknown>) =>
  evaluateExpr(parseExpr(expr), (path) =>
    path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], params),
  );

describe("expr", () => {
  it("precedence: comparison > and > or", () => {
    const p = { active: false, status: "a", expected: "a", pending: true };
    assert.equal(evaluate("active or status = expected and pending", p), true);
    assert.equal(evaluate("(active or status = expected) and pending", p), true);
    assert.equal(evaluate("active and (status = expected or pending)", p), false);
  });

  it("dot paths", () => {
    assert.equal(evaluate("user.id = owner.id", { user: { id: 10 }, owner: { id: 10 } }), true);
  });

  it("ordering with null throws", () => {
    assert.throws(() => evaluate("a < b", { a: null, b: 1 }));
  });

  it("syntax errors", () => {
    assert.throws(() => parseExpr("a ="));
    assert.throws(() => parseExpr("(a"));
    assert.throws(() => parseExpr("a = 'x'"));
    assert.throws(() => parseExpr(""));
  });
});
