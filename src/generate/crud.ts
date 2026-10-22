/**
 * テーブル定義から CRUD の 2-way SQL テンプレートを作る（純粋関数）。
 *
 * 生成されるクエリ:
 *   insert, insert-many, get-by-<unique>, list, list-by-<index prefix>, list-by-<...>-starting-with,
 *   count, count-by-<...>, count-by-<...>-starting-with, update-by-<unique>, delete-by-<unique>, upsert-by-<unique>
 */
import type { Column, Table } from "./introspect.ts";

export type GeneratedQuery = { name: string; sql: string };

export function generateCrud(table: Table): GeneratedQuery[] {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const col = (name: string): Column => byName.get(name) as Column;
  const out: GeneratedQuery[] = [];
  const insertable = table.columns.filter((c) => c.generated === "" && c.identity !== "a");
  const qualified = table.schema === "public" ? quote(table.name) : `${quote(table.schema)}.${quote(table.name)}`;

  if (insertable.length > 0) {
    out.push({ name: "insert", sql: insertTemplate(qualified, insertable, null) });
    out.push({ name: "insert-many", sql: insertTemplate(qualified, insertable, "row") });
  }

  for (const group of table.uniqueGroups) {
    const columns = group.map(col);
    const suffix = joinedName(group);
    out.push({ name: `get-by-${suffix}`, sql: `SELECT * FROM ${qualified}\n${whereClause(columns.map(exact), null)}` });
    out.push({
      name: `delete-by-${suffix}`,
      sql: `DELETE FROM ${qualified}\n${whereClause(columns.map(exact), null)}\nRETURNING *`,
    });
    // SET のサンプル列: キーでも主キーでもない最初の挿入可能列
    const updatable = insertable.filter((c) => !group.includes(c.name) && !(table.primaryKey ?? []).includes(c.name));
    const sample = updatable[0] ?? insertable.find((c) => !group.includes(c.name)) ?? insertable[0];
    if (sample) {
      out.push({ name: `update-by-${suffix}`, sql: updateTemplate(qualified, columns, sample) });
      out.push({ name: `upsert-by-${suffix}`, sql: upsertTemplate(qualified, insertable, group, sample) });
    }
  }

  out.push(...listTemplates(qualified, table, col));
  out.push(...countTemplates(qualified, table, col));
  return dedupeByName(out);
}

// --- insert / update / upsert -------------------------------------------------

function insertTemplate(table: string, columns: Column[], rowPrefix: string | null): string {
  const names = columns.map((c) => `  ${quote(c.name)}`).join(",\n");
  const values = columns.map((c) => `  ${bind(prefixed(rowPrefix, c.name), c, { insert: true })}`).join(",\n");
  if (rowPrefix === null) return `INSERT INTO ${table} (\n${names}\n)\nVALUES (\n${values}\n)\nRETURNING *`;
  return `INSERT INTO ${table} (\n${names}\n)\nVALUES\n/*%for ${rowPrefix} in rows separating , */\n(\n${values}\n)\n/*%end */\nRETURNING *`;
}

function setClause(sample: Column): string {
  return `SET\n/*%for item in updates separating , */\n  /*!item.name*/${quote(sample.name)} = ${bind("item.value", sample, {})}\n/*%end */`;
}

function updateTemplate(table: string, keys: Column[], sample: Column): string {
  return `UPDATE ${table}\n${setClause(sample)}\n${whereClause(keys.map(exact), "where")}\nRETURNING *`;
}

function upsertTemplate(table: string, columns: Column[], conflict: string[], sample: Column): string {
  const names = columns.map((c) => `  ${quote(c.name)}`).join(",\n");
  // 衝突対象の列は必ず渡す（何に一致させるかを決めるため）
  const values = columns
    .map((c) => `  ${bind(`inserts.${c.name}`, c, { insert: !conflict.includes(c.name) })}`)
    .join(",\n");
  return [
    `INSERT INTO ${table} (`,
    names,
    ")",
    "VALUES (",
    values,
    ")",
    `ON CONFLICT (${conflict.map(quote).join(", ")})`,
    "/*%if updates */",
    `DO UPDATE ${setClause(sample)}`,
    "/*%else => DO NOTHING */",
    "/*%end */",
    "RETURNING *",
  ].join("\n");
}

// --- list / count -------------------------------------------------------------

type Candidate = { prefix: string[]; order: string[]; startsWith: boolean };

function candidates(table: Table): Candidate[] {
  const seen = new Map<string, Candidate>();
  const add = (c: Candidate) => seen.set(JSON.stringify([c.prefix, c.order, c.startsWith]), c);
  // 条件なしの list は主キー順で 1 つだけ
  add({ prefix: [], order: table.primaryKey ?? [], startsWith: false });
  // ユニークな組は真の接頭辞だけ（全列一致は get-by-* が担う）、通常のインデックスは全長まで
  for (const group of table.uniqueGroups)
    for (let n = 1; n < group.length; n++) add({ prefix: group.slice(0, n), order: group.slice(n), startsWith: false });
  for (const group of table.indexGroups)
    for (let n = 1; n <= group.length; n++)
      add({ prefix: group.slice(0, n), order: group.slice(n), startsWith: false });
  return [...seen.values()];
}

function startsWithCandidates(table: Table, col: (name: string) => Column): string[][] {
  const groups = [...table.uniqueGroups, ...table.indexGroups].filter(
    (g) => g.length > 0 && isText(col(g[g.length - 1] as string)),
  );
  return dedupeGroups(groups);
}

function listTemplates(table: string, t: Table, col: (name: string) => Column): GeneratedQuery[] {
  const out: GeneratedQuery[] = [];
  const all = candidates(t);
  const baseName = (prefix: string[]) => (prefix.length > 0 ? `list-by-${joinedName(prefix)}` : "list");
  const colliding = new Set(
    [...Map.groupBy(all, (c) => baseName(c.prefix))].filter(([, cs]) => cs.length > 1).map(([name]) => name),
  );
  for (const c of all) {
    const base = baseName(c.prefix);
    const name = colliding.has(base) && c.order.length > 0 ? `${base}-order-by-${joinedName(c.order)}` : base;
    out.push({
      name,
      sql: selectTemplate(
        table,
        c.prefix.map((n) => exact(col(n))),
        c.order,
      ),
    });
  }
  for (const group of startsWithCandidates(t, col)) {
    const exacts = group.slice(0, -1).map((n) => exact(col(n)));
    const last = col(group[group.length - 1] as string);
    out.push({
      name: `list-by-${joinedName(group)}-starting-with`,
      sql: selectTemplate(table, [...exacts, startsWith(last)], [last.name]),
    });
  }
  return out;
}

function countTemplates(table: string, t: Table, col: (name: string) => Column): GeneratedQuery[] {
  const out: GeneratedQuery[] = [];
  const prefixes = dedupeGroups(candidates(t).map((c) => c.prefix));
  for (const prefix of prefixes) {
    const name = prefix.length > 0 ? `count-by-${joinedName(prefix)}` : "count";
    out.push({
      name,
      sql: `SELECT count(*)::int AS count FROM ${table}\n${whereClause(
        prefix.map((n) => exact(col(n))),
        null,
      )}`.trimEnd(),
    });
  }
  for (const group of startsWithCandidates(t, col)) {
    const exacts = group.slice(0, -1).map((n) => exact(col(n)));
    const last = col(group[group.length - 1] as string);
    out.push({
      name: `count-by-${joinedName(group)}-starting-with`,
      sql: `SELECT count(*)::int AS count FROM ${table}\n${whereClause([...exacts, startsWith(last)], null)}`,
    });
  }
  return out;
}

function selectTemplate(table: string, predicates: Predicate[], order: string[]): string {
  const lines = [`SELECT * FROM ${table}`];
  const where = whereClause(predicates, null);
  if (where) lines.push(where);
  if (order.length > 0) lines.push(`ORDER BY ${order.map(quote).join(", ")}`);
  lines.push("LIMIT /*$limit*/100");
  return lines.join("\n");
}

// --- predicates ---------------------------------------------------------------

type Predicate = (prefix: string | null) => string;

function exact(c: Column): Predicate {
  return (prefix) => `${quote(c.name)} = ${bind(prefixed(prefix, c.name), c, {})}`;
}

function startsWith(c: Column): Predicate {
  return (prefix) => `${quote(c.name)} LIKE /*$${prefixed(prefix, c.name)}*/'sample%' ESCAPE '\\'`;
}

function whereClause(predicates: Predicate[], prefix: string | null): string {
  if (predicates.length === 0) return "";
  return `WHERE ${predicates.map((p) => p(prefix)).join("\n  AND ")}`;
}

// --- helpers ------------------------------------------------------------------

function bind(param: string, c: Column, options: { insert?: boolean }): string {
  if (options.insert && isDefaultable(c)) return `/*$${param} default-to */DEFAULT`;
  return `/*$${param}*/${sampleToken(c)}`;
}

function isDefaultable(c: Column): boolean {
  return c.hasDefault || c.identity !== "" || !c.notNull;
}

function prefixed(prefix: string | null, name: string): string {
  return prefix === null ? name : `${prefix}.${name}`;
}

export function sampleToken(c: Column): string {
  if (c.typtype === "e") return c.enumLabels?.[0] === undefined ? "NULL" : `'${c.enumLabels[0].replaceAll("'", "''")}'`;
  if (c.category === "A") return "'{}'";
  switch (c.typeName) {
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
    case "oid":
      return "1";
    case "bool":
      return "true";
    case "text":
    case "varchar":
    case "bpchar":
    case "name":
    case "citext":
      return "'sample'";
    case "uuid":
      return "'00000000-0000-0000-0000-000000000000'";
    case "date":
      return "'2024-01-01'";
    case "timestamp":
      return "'2024-01-01 00:00:00'";
    case "timestamptz":
      return "'2024-01-01 00:00:00+00'";
    case "time":
    case "timetz":
      return "'00:00:00'";
    case "interval":
      return "'1 day'";
    case "json":
    case "jsonb":
      return "'{}'";
    case "bytea":
      return "'\\x00'";
    default:
      return "NULL";
  }
}

function isText(c: Column): boolean {
  return ["text", "varchar", "bpchar", "citext"].includes(c.typeName) || (c.typtype === "d" && c.category === "S");
}

export function quote(identifier: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(identifier) ? identifier : `"${identifier.replaceAll('"', '""')}"`;
}

export function kebab(name: string): string {
  return name.replaceAll("_", "-");
}

function joinedName(columns: string[]): string {
  return columns.map(kebab).join("-and-");
}

function dedupeGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  return groups.filter((g) => {
    const key = g.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeByName(queries: GeneratedQuery[]): GeneratedQuery[] {
  const seen = new Set<string>();
  return queries.filter((q) => {
    if (seen.has(q.name)) return false;
    seen.add(q.name);
    return true;
  });
}
