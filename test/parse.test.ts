import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse, TysqlError } from "../src/index.ts";

describe("parse", () => {
  it("records spans of variables, names and samples", () => {
    const sql = "SELECT * FROM users WHERE id = /*$userId*/1";
    const t = parse(sql);
    const v = t.nodes[1];
    assert.ok(v && v.kind === "bind");
    assert.deepEqual(v.path, ["userId"]);
    assert.equal(sql.slice(v.name.start, v.name.end), "userId");
    assert.equal(sql.slice(v.sampleSpan.start, v.sampleSpan.end), "1");
    assert.equal(sql.slice(v.start, v.end), "/*$userId*/1");
  });

  it("requires a sample directly after the comment", () => {
    assert.throws(
      () => parse("SELECT /*$id*/ 1"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/missing-sample",
    );
  });

  it("rejects kebab-case names", () => {
    assert.throws(
      () => parse("SELECT /*$order-by*/1"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/invalid-name",
    );
  });

  it("rejects default-to on literal and raw", () => {
    assert.throws(
      () => parse("SELECT /*^v default-to */1"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/default-to-sigil",
    );
  });

  it("rejects nested for and unterminated blocks", () => {
    assert.throws(
      () => parse("/*%for a in xs*/ /*%for b in ys*/ /*%end*/ /*%end*/"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/nested-for",
    );
    assert.throws(
      () => parse("/*%if a*/ x"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/unterminated-block",
    );
    assert.throws(
      () => parse("x /*%end*/"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/unexpected-directive",
    );
  });

  it("rejects elseif after else", () => {
    assert.throws(
      () => parse("/*%if a*/ x /*%else*/ y /*%elseif b*/ z /*%end*/"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/else-order",
    );
  });

  it("rejects declarations after the SQL starts", () => {
    assert.throws(
      () => parse("SELECT 1 /*:doc x */"),
      (e: unknown) => e instanceof TysqlError && e.code === "parse/declaration-position",
    );
  });

  it("allows if inside for", () => {
    const t = parse("/*%for i in xs*/ /*%if i.a*/ a /*%end*/ /*%end*/");
    const f = t.nodes[0];
    assert.ok(f && f.kind === "for");
    assert.ok(f.body.some((n) => n.kind === "if"));
  });

  it("handles dollar quoting and E-strings as opaque text", () => {
    const sql = "SELECT $$ /*$x*/ $$, E'\\'/*$y*/', /*$z*/1";
    const t = parse(sql);
    const vars = t.nodes.filter((n) => n.kind === "bind");
    assert.equal(vars.length, 1);
  });
});
