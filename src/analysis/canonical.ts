/**
 * 正準描画。Describe に送る 1 文を作る。
 *
 * - `$` はサンプルを `$n` に置き換える（直後のキャストはテンプレートのテキストとして残る）
 * - コレクションの `$` は `($n)` にする
 * - `^` と `!` はサンプルをそのまま残す
 * - `if` は最初の分岐だけを採る
 * - `for` は本文を 1 回だけ描画する
 */
import type { Node, Template, VariableNode } from "../core/parse.ts";

export type Placeholder = {
  /** `$n` の n */
  index: number;
  /** 正準描画上の `$n` の位置 */
  at: number;
  node: VariableNode;
  /** `for` の item 名。ループ外なら null */
  loopItem: string | null;
};

/** 正準描画の区間 [from, to) がテンプレートの templateStart からの同じ長さに対応する */
export type Piece = { from: number; to: number; templateStart: number };

export type Canonical = {
  sql: string;
  placeholders: Placeholder[];
  pieces: Piece[];
};

export function canonical(template: Template): Canonical {
  const state = {
    sql: "",
    placeholders: [] as Placeholder[],
    pieces: [] as Piece[],
    byPath: new Map<string, number>(),
  };
  walk(template.nodes, null, state);
  return { sql: state.sql, placeholders: state.placeholders, pieces: state.pieces };
}

type State = { sql: string; placeholders: Placeholder[]; pieces: Piece[]; byPath: Map<string, number> };

function walk(nodes: Node[], loopItem: string | null, state: State): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        verbatim(state, node.text, node.start);
        break;
      case "bind": {
        const key = node.path.join(".");
        const inLoop = loopItem !== null && node.path[0] === loopItem;
        let index = inLoop || node.collection ? undefined : state.byPath.get(key);
        if (index === undefined) {
          index = state.placeholders.length + 1;
          state.placeholders.push({ index, at: state.sql.length, node, loopItem: inLoop ? loopItem : null });
          if (!inLoop && !node.collection) state.byPath.set(key, index);
        }
        state.sql += node.collection ? `($${index})` : `$${index}`;
        break;
      }
      case "literal":
      case "raw":
        verbatim(state, node.sample, node.sampleSpan.start);
        break;
      case "if": {
        const first = node.branches[0];
        if (first) walk(first.body, loopItem, state);
        break;
      }
      case "for":
        walk(node.body, node.item, state);
        break;
    }
  }
}

function verbatim(state: State, text: string, templateStart: number): void {
  if (text.length === 0) return;
  state.pieces.push({ from: state.sql.length, to: state.sql.length + text.length, templateStart });
  state.sql += text;
}

/** 正準描画上の offset をテンプレート上の offset に投影する。対応がなければ直前の区間の末尾。 */
export function projectOffset(canon: Canonical, offset: number): number {
  let best = 0;
  for (const piece of canon.pieces) {
    if (offset >= piece.from && offset < piece.to) return piece.templateStart + (offset - piece.from);
    if (piece.to <= offset) best = piece.templateStart + (piece.to - piece.from);
  }
  return best;
}
