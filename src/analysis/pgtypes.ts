/**
 * Postgres の型 OID から TypeScript の型へ。`pg`（node-postgres）の既定の出力に合わせる。
 *
 * - int8 / numeric / money は文字列
 * - date / timestamp / timestamptz は Date
 * - json / jsonb は unknown（パース済み）
 * - bytea は Buffer
 * - enum はラベルの union
 * - 配列は要素型の配列
 */
import type { Describer } from "./describer.ts";

export type PgType = {
  oid: number;
  name: string;
  /** b=base, e=enum, d=domain, c=composite, r=range, m=multirange, p=pseudo */
  typtype: string;
  category: string;
  elem: number;
  base: number;
  labels: string[] | null;
};

const BUILTIN: Readonly<Record<number, string>> = {
  16: "boolean",
  17: "Buffer",
  18: "string", // char
  19: "string", // name
  20: "string", // int8
  21: "number", // int2
  23: "number", // int4
  25: "string", // text
  26: "number", // oid
  114: "unknown", // json
  142: "string", // xml
  600: "unknown", // point
  700: "number", // float4
  701: "number", // float8
  790: "string", // money
  869: "string", // inet
  1042: "string", // bpchar
  1043: "string", // varchar
  1082: "Date", // date
  1083: "string", // time
  1114: "Date", // timestamp
  1184: "Date", // timestamptz
  1186: "string", // interval
  1266: "string", // timetz
  1700: "string", // numeric
  2950: "string", // uuid
  3802: "unknown", // jsonb
  3614: "string", // tsvector
  3615: "string", // tsquery
};

const TYPES_QUERY = `
  SELECT t.oid::int AS oid, t.typname AS name, t.typtype::text AS typtype, t.typcategory::text AS category,
         t.typelem::int AS elem, t.typbasetype::int AS base,
         (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
    FROM pg_type t
   WHERE t.oid = ANY($1::oid[])`;

/** OID 群の型情報を（要素型・基底型を辿って）読む。 */
export async function loadTypes(
  describer: Describer,
  oids: Iterable<number>,
  cache = new Map<number, PgType>(),
): Promise<Map<number, PgType>> {
  let pending = [...new Set(oids)].filter((oid) => oid !== 0 && !cache.has(oid));
  while (pending.length > 0) {
    const rows = await describer.query<PgType>(TYPES_QUERY, [pending]);
    const next: number[] = [];
    for (const row of rows) {
      cache.set(row.oid, { ...row, labels: row.labels ?? null });
      for (const ref of [row.elem, row.base]) if (ref !== 0 && !cache.has(ref)) next.push(ref);
    }
    for (const oid of pending)
      if (!cache.has(oid))
        cache.set(oid, { oid, name: "?", typtype: "?", category: "?", elem: 0, base: 0, labels: null });
    pending = [...new Set(next)].filter((oid) => !cache.has(oid));
  }
  return cache;
}

export function tsTypeOf(oid: number, types: Map<number, PgType>): string {
  const builtin = BUILTIN[oid];
  if (builtin !== undefined) return builtin;
  const t = types.get(oid);
  if (!t) return "unknown";
  if (t.typtype === "e" && t.labels) return t.labels.map((l) => JSON.stringify(l)).join(" | ") || "never";
  if (t.typtype === "d" && t.base !== 0) return tsTypeOf(t.base, types);
  if (t.category === "A" && t.elem !== 0) {
    const elem = tsTypeOf(t.elem, types);
    return elem.includes(" | ") ? `(${elem})[]` : `${elem}[]`;
  }
  return "unknown";
}

const NOT_NULL_QUERY = `
  SELECT a.attrelid::int AS rel, a.attnum::int AS attnum
    FROM pg_attribute a
   WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND a.attnotnull`;

/** `rel:attnum` の集合として NOT NULL 列を返す。 */
export async function loadNotNull(describer: Describer, tables: Iterable<number>): Promise<Set<string>> {
  const rels = [...new Set(tables)].filter((t) => t !== 0);
  if (rels.length === 0) return new Set();
  const rows = await describer.query<{ rel: number; attnum: number }>(NOT_NULL_QUERY, [rels]);
  return new Set(rows.map((r) => `${r.rel}:${r.attnum}`));
}

/** 名前（`schema.table` や `"quoted"`）のリレーション OID。存在しなければ null。 */
export async function relationOid(describer: Describer, name: string): Promise<number | null> {
  try {
    const rows = await describer.query<{ oid: number }>("SELECT $1::regclass::oid::int AS oid", [name]);
    return rows[0]?.oid ?? null;
  } catch {
    return null;
  }
}

/**
 * パラメータ（入力）の型。出力より広く、ドライバが文字列化して送れる値を受け付ける。
 * `int8` / `numeric` は `string | number | bigint`、日時は `Date | string`。
 */
const INPUT_OVERRIDE: Readonly<Record<number, string>> = {
  20: "string | number | bigint", // int8
  1700: "string | number | bigint", // numeric
  790: "string | number", // money
  1082: "Date | string", // date
  1114: "Date | string", // timestamp
  1184: "Date | string", // timestamptz
  17: "Buffer | Uint8Array", // bytea
};

export function tsInputTypeOf(oid: number, types: Map<number, PgType>): string {
  const override = INPUT_OVERRIDE[oid];
  if (override !== undefined) return override;
  const t = types.get(oid);
  if (t && t.typtype === "d" && t.base !== 0) return tsInputTypeOf(t.base, types);
  if (t && t.category === "A" && t.elem !== 0) {
    const elem = tsInputTypeOf(t.elem, types);
    return elem.includes(" | ") ? `(${elem})[]` : `${elem}[]`;
  }
  return tsTypeOf(oid, types);
}
