/**
 * CRUD 生成のためのスキーマ読み取り。
 */
import type { Describer } from "../analysis/describer.ts";

export type Column = {
  name: string;
  oid: number;
  typeName: string;
  /** b=base, e=enum, d=domain, ... */
  typtype: string;
  category: string;
  notNull: boolean;
  hasDefault: boolean;
  /** 'a' = GENERATED ALWAYS AS IDENTITY, 'd' = BY DEFAULT, '' = なし */
  identity: string;
  /** 's' = 生成列、'' = なし */
  generated: string;
  enumLabels: string[] | null;
};

export type Table = {
  schema: string;
  name: string;
  oid: number;
  columns: Column[];
  /** 主キーの列名。なければ null */
  primaryKey: string[] | null;
  /** 主キーを含むユニーク制約・ユニークインデックスの列名の組（主キーが先頭） */
  uniqueGroups: string[][];
  /** ユニークでない通常のインデックスの列名の組 */
  indexGroups: string[][];
};

type TableRow = { schema: string; name: string; oid: number };
type ColumnRow = {
  rel: number;
  attnum: number;
  name: string;
  oid: number;
  type_name: string;
  typtype: string;
  category: string;
  not_null: boolean;
  has_default: boolean;
  identity: string;
  generated: string;
  labels: string[] | null;
};
type IndexRow = {
  rel: number;
  name: string;
  primary: boolean;
  unique: boolean;
  keys: number[] | string;
  plain: boolean;
  total: boolean;
};

export async function introspect(describer: Describer, schemas: string[]): Promise<Table[]> {
  const tables = await describer.query<TableRow>(
    `SELECT n.nspname AS schema, c.relname AS name, c.oid::int AS oid
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1::text[])
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  if (tables.length === 0) return [];
  const oids = tables.map((t) => t.oid);
  const columns = await describer.query<ColumnRow>(
    `SELECT a.attrelid::int AS rel, a.attnum::int AS attnum, a.attname::text AS name, a.atttypid::int AS oid,
            t.typname::text AS type_name, t.typtype::text AS typtype, t.typcategory::text AS category,
            a.attnotnull AS not_null, a.atthasdef AS has_default, a.attidentity::text AS identity, a.attgenerated::text AS generated,
            (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS labels
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
    [oids],
  );
  const indexes = await describer.query<IndexRow>(
    `SELECT i.indrelid::int AS rel, ic.relname::text AS name, i.indisprimary AS "primary", i.indisunique AS "unique",
            i.indkey::int2[] AS keys, i.indexprs IS NULL AS plain, i.indpred IS NULL AS total
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = ANY($1::oid[]) AND i.indisvalid
      ORDER BY i.indrelid, i.indisprimary DESC, ic.relname`,
    [oids],
  );

  return tables.map((t): Table => {
    const cols = columns.filter((c) => c.rel === t.oid);
    const byAttnum = new Map(cols.map((c) => [c.attnum, c.name]));
    const groups = indexes
      .filter((i) => i.rel === t.oid && i.plain && i.total)
      .map((i) => ({ ...i, names: parseKeys(i.keys).map((k) => byAttnum.get(k) ?? null) }))
      .filter((i) => i.names.every((n) => n !== null))
      .map((i) => ({ ...i, names: i.names as string[] }));
    const primary = groups.find((g) => g.primary)?.names ?? null;
    const uniqueGroups = dedupe(groups.filter((g) => g.unique).map((g) => g.names));
    const indexGroups = dedupe(groups.filter((g) => !g.unique).map((g) => g.names)).filter(
      (g) => !uniqueGroups.some((u) => sameGroup(u, g)),
    );
    return {
      schema: t.schema,
      name: t.name,
      oid: t.oid,
      columns: cols.map(
        (c): Column => ({
          name: c.name,
          oid: c.oid,
          typeName: c.type_name,
          typtype: c.typtype,
          category: c.category,
          notNull: c.not_null,
          hasDefault: c.has_default,
          identity: c.identity,
          generated: c.generated,
          enumLabels: c.labels,
        }),
      ),
      primaryKey: primary,
      uniqueGroups,
      indexGroups,
    };
  });
}

function parseKeys(keys: number[] | string): number[] {
  if (Array.isArray(keys)) return keys.map(Number);
  return keys
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter((s) => s !== "")
    .map(Number);
}

function sameGroup(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function dedupe(groups: string[][]): string[][] {
  const out: string[][] = [];
  for (const g of groups) if (!out.some((o) => sameGroup(o, g))) out.push(g);
  return out;
}
