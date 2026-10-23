# trisql 2-way SQL Specification

Status: design draft (2026-10-23). Updated as the implementation lands.
For the differences from bisql only, see [differences-from-bisql.md](./differences-from-bisql.md).

## 1. Principles

- **A template is valid SQL.** With its sample values in place, it runs on PostgreSQL as written.
- **Only block comments are template syntax.** Strip every comment and plain SQL remains.
- **One file, one query.** The file path identifies the query, which is the module's default export.
- **Declarations are minimal.** Types come from the SQL text and the database (an embedded PGlite by default). The only declaration comment is `doc`.
- **Cardinality is chosen by the TypeScript call API, not in the SQL.**
- **PostgreSQL is the target.** Placeholders render as `$n`.

## 2. Sigils

The first character of a block comment is reserved as a sigil.

| Sigil | Form | Role |
|---|---|---|
| `$` | `/*$name*/sample` | Bind variable, rendered as `$n` |
| `^` | `/*^name*/sample` | Literal, inlined as a SQL literal |
| `!` | `/*!name*/sample` | Raw, inlined as a SQL fragment as-is |
| `%` | `/*%if ... */` etc. | Control flow (if / elseif / else / end / for) |
| `:` | `/*:doc ... */` | Declaration (`doc` only) |

An ordinary comment must not start with a sigil. Write `/* ... */` (leading space) or `/** ... */`.
A `--` line comment is always an ordinary comment and never carries template syntax.
Ordinary comments are kept in the rendered SQL.

## 3. Bind variables `$`

```sql
SELECT * FROM users WHERE id = /*$id*/1
```

```ts
render({ id: 42 })
// { sql: "SELECT * FROM users WHERE id = $1", params: [42] }
```

### 3.1 Names

- A JavaScript identifier (`[A-Za-z_][A-Za-z0-9_]*`). camelCase is recommended. kebab-case is not allowed.
- A dot path (`/*$where.id*/`, `/*$item.value*/`) reads a nested object.
- The same name appearing more than once reuses the same `$n`.

### 3.2 Sample values

Placed immediately after the comment, with no whitespace. One of:

- a string literal `'...'` (one token, including inner `''`)
- a single token up to a delimiter: a number, `true` / `false` / `NULL`, `DEFAULT`, `CURRENT_TIMESTAMP`, and the like
- a parenthesized collection `(1, 2, 3)` (nested parentheses allowed)
- a dollar-quoted string `$$...$$`, also one token

A `::type` cast that follows the sample stays in the SQL.

```sql
WHERE created_at > /*$since*/'2024-01-01'::timestamptz
-- → WHERE created_at > $1::timestamptz
```

The cast feeds the parameter typing done by Describe, so writing one is recommended wherever the type would otherwise be ambiguous.

### 3.3 Collection binding

```sql
WHERE id IN /*$ids*/(1, 2, 3)
```

```ts
render({ ids: [10, 20, 30] })
// { sql: "WHERE id IN ($1, $2, $3)", params: [10, 20, 30] }
```

- The value must be an array. An empty array is an error.
- `DEFAULT`, `ALL` and the LIKE helpers are not allowed as elements.

### 3.4 `undefined` and `null`

- `undefined` (and a missing key) means **not given**. With `default-to` the fallback is used; otherwise it is an error.
- `null` is bound as an **explicit NULL**.

### 3.5 `default-to`

```sql
INSERT INTO users (id, email)
VALUES (/*$id default-to */DEFAULT, /*$email*/'user@example.com')
```

When the parameter is not given, the sample SQL fragment (`DEFAULT` here) is kept as written.
A parameter with `default-to` is optional in the `Params` type.
Only `$` binds accept it.

### 3.6 Special values

- `DEFAULT`, `ALL`: unique symbols exported by trisql. Passing one renders the SQL keyword `DEFAULT` / `ALL` instead of `$n`. Scalar `$` binds only.
- `LIKE_STARTS_WITH(s)`, `LIKE_ENDS_WITH(s)`, `LIKE_CONTAINS(s)`: bind a value with `%`, `_` and `\` escaped and `%` added in the right place. Write `ESCAPE '\'` on the SQL side.

```sql
WHERE name LIKE /*$search*/'foo%' ESCAPE '\'
```

```ts
render({ search: LIKE_CONTAINS("100%") })
// params: ["%100\\%%"]
```

## 4. Literals `^`

```sql
WHERE type = /*^type*/'A'
```

```ts
render({ type: "BOOK" })
// { sql: "WHERE type = 'BOOK'", params: [] }
```

- A string is wrapped in `'` with inner `'` doubled to `''`.
- A number is inlined as-is.
- Any other type is an error.
- Use it only where a bind cannot do the job, such as splitting prepared-statement cache entries.

## 5. Raw `!`

```sql
ORDER BY /*!orderBy*/created_at DESC
```

```ts
render({ orderBy: "updated_at ASC" })
// { sql: "ORDER BY updated_at ASC", params: [] }
```

- The value is a string, inlined without validation.
- **Never pass user input directly.** Check it against an allow list on the caller's side.
- When a `for` block uses `Record` keys as column names, each key is validated as an identifier (`[A-Za-z_][A-Za-z0-9_]*`).

## 6. Control flow `%`

### 6.1 if / elseif / else / end

```sql
SELECT *
FROM users
WHERE
/*%if active */
  active = true
/*%elseif pending */
  status = 'pending'
/*%else */
  status = 'inactive'
/*%end */
```

A branch body can also be written inline.

```sql
/*%if active */
  active = true
/*%elseif pending => status = 'pending' */
/*%else => status = 'inactive' */
/*%end */
```

A branch cannot mix an inline body with a block body.
`elseif` cannot follow `else`. At most one `else`.

### 6.2 Conditions

A small expression language.

- logical operators `and`, `or`
- comparison operators `=`, `!=`, `<`, `<=`, `>`, `>=`
- parentheses
- operands are parameter references only, dot paths allowed. No literals, arithmetic, function calls or `not`
- a bare identifier is a truthiness test

Precedence is comparison > `and` > `or`.

Truthiness rules:

- **Only `null`, `undefined` and `false` are falsy.** `0`, `""`, `NaN` and an empty array are truthy.
- Comparisons use `===`. Comparing two objects is undefined behavior.

### 6.3 for

```sql
UPDATE users
SET
/*%for item in updates separating , */
  /*!item.name*/display_name = /*$item.value*/'sample'
/*%end */
WHERE id = /*$id*/1
```

- `separating <sep>` sets the separator between items. Without it, items are joined with nothing.
- The collection is an array or a `Record<string, T>`. A `Record` is treated as an array of `{ name: key, value }`, and each key is validated as an identifier.
- An `if` may appear inside a `for`. Nested `for` is not supported in v1.

### 6.4 Cleaning up emptied clauses

When a branch or loop leaves a clause empty:

- A preceding `WHERE` / `HAVING` that would be left dangling is removed.
- A following `AND` / `OR` is removed.
- An empty `SET` / `VALUES` is an error (it is not valid SQL).

## 7. Declarations `:`

Allowed only at the top of the template. Currently `doc` only.

```sql
/*:doc Loads one user by id. */
SELECT * FROM users WHERE id = /*$id*/1
```

- The body is plain text and may span lines. It becomes the JSDoc of the generated type.
- Any declaration other than `doc` is an error. `/*: */` is reserved for future extension.

## 8. File layout

- One file, one query. A file cannot hold several statements.
- The default export of `import q from "./users/get-by-id.sql"` is the query.
- No layout convention is enforced. CRUD generation writes one query per file into a directory per table, plus a barrel (`index.ts`).

```text
sql/public/users/crud/get-by-id.sql
sql/public/users/crud/list-by-email.sql
sql/public/users/crud/index.ts   // export { default as getById } from "./get-by-id.sql"; ...
```

## 9. CRUD generation

`trisql generate` applies the configured DDL to the embedded PGlite and writes index-friendly CRUD templates per table.

```jsonc
// trisql.json
{ "schema": ["db/schema.sql"], "generate": { "out": "sql", "schemas": ["public"] } }
```

Files go to `<out>/<schema>/<table>/crud/<query>.sql`. The `public` schema gets the same layout; it is not special.
A barrel `index.ts` is written beside them, so `import { getById } from "./sql/public/users/crud"` works.
The generator owns the `crud/` directory: `.sql` files and `index.ts` it did not write this time are removed.

Generated queries:

| Name | Content |
|---|---|
| `insert`, `insert-many` | Every insertable column. Columns with a default or identity, and nullable columns, are optional through `default-to`. `RETURNING *` |
| `get-by-<unique>`, `delete-by-<unique>` | One row by the primary key and by each unique key |
| `update-by-<unique>` | Partial update through `where` and `updates` (a `for` loop) |
| `upsert-by-<unique>` | `inserts` and `updates`; `DO NOTHING` when `updates` is not given |
| `list`, `list-by-<index prefix>` | All rows in primary-key order, and rows by each index prefix, ordered by the remaining columns, with `LIMIT` |
| `list-by-<...>-starting-with`, `count-by-<...>-starting-with` | Prefix match (`LIKE ... ESCAPE`) on indexes whose last column is text |
| `count`, `count-by-<index prefix>` | Row counts |

Generated columns (`GENERATED ALWAYS AS`) and `GENERATED ALWAYS AS IDENTITY` columns are not inserted.
Multi-column names are joined with `-and-`, and `_` in column names becomes `-`.

## 10. Typing

At type-check time the content mapper analyzes each template and derives `Params` and `Row`.

### 10.1 Sources

- Default: the DDL named in the configuration (migrations or a `schema.sql`) is applied to an embedded PGlite, which answers Parse/Describe and catalog queries.
- With `databaseUrl`: the same queries go to that PostgreSQL.
- Both sit behind one `Describer` interface and must produce the same analysis.

### 10.2 Canonical rendering

Describe accepts one statement, so one "canonical rendering" is built from the template and sent.

- `$` samples become `$n`; a following `::type` is kept
- A `default-to` bind also becomes `$n` (to obtain its type)
- `^` and `!` keep their samples as written
- For `if`, **only the first branch (the `if` body)** is taken; `elseif` / `else` are dropped
- A `for` body is rendered once
- Ordinary comments are kept

The definition makes "the raw file is valid SQL" and "the canonical rendering is valid SQL" equivalent.
For that reason `elseif` / `else` bodies should be written inline (`=>`); a block body makes the raw file itself invalid SQL.

A parameter that appears only inside `elseif` / `else` gets no type from Describe and falls back to its sample literal type.
Describing one rendering per branch is a v2 consideration.

A table mapping each character of the canonical rendering back to its template offset is kept, so that a PostgreSQL error position (`position`) or a column name position can be projected onto the template.

### 10.3 Params

| Occurrence | Type | Optional |
|---|---|---|
| scalar `$` | cast after the sample > Describe parameter type > sample literal type | with `default-to` |
| input types of `$` are wider than output types | `int8` `numeric` are `string | number | bigint`, date/time are `Date | string`, `bytea` is `Buffer | Uint8Array` | |
| collection `$` | array of the element type | same |
| `$` / `^` / `!` inside an `if` branch | as above | optional (needed only when the branch is taken) |
| `^` | the sample's type (`string` or `number`) | no |
| `!` | `string` | no |
| bare identifier in `if` (not used elsewhere) | `boolean \| null \| undefined` | yes |
| comparison operand in `if` (not used elsewhere) | `unknown` | yes |
| `if` operand that is also a `$` elsewhere | that `$`'s type | as that `$` |
| `xs` in `for item in xs` | `Array<{...}>` or `Record<string, T>`, element shape built from how `item.*` is used in the body | no |

Where `DEFAULT` / `ALL` / a LIKE helper is accepted, its type joins the union.

### 10.4 Row

- Column names and types come from the RowDescription of Describe. Names stay snake_case.
- Type OIDs map to TypeScript types following the default output of `pg` (node-postgres): `int2` `int4` `float4` `float8` are `number`, `int8` and `numeric` are `string`, `text` `varchar` `uuid` are `string`, `bool` is `boolean`, `date` `timestamp` `timestamptz` are `Date`, `json` `jsonb` are `unknown`, `bytea` is `Buffer`, an enum is the union of its labels, an array is an array of its element type. Anything else is `unknown`.
- PGlite returns `int8` as a `BigInt` (or `number` when safe) and differs from `pg` in a few places, but the table follows `pg`.
- Nullability comes from `pg_attribute.attnotnull` of the source table. A column with no source table (an expression) is nullable.
- When the statement contains an outer join (`LEFT` / `RIGHT` / `FULL JOIN`), the parse tree (`libpg-query`, an optional peer) identifies the relations on the nullable side, and columns from those tables become nullable. Nested joins, subselects and CTEs are followed. A self join that puts the same table on both sides is treated as nullable. Without `libpg-query`, the conservative rule applies: every column from a table other than the first in `FROM` is nullable.
- A DML statement without `RETURNING` has no `Row`.

### 10.5 Cardinality

The analysis carries an estimate of how many rows the statement returns, `one` / `maybeOne` / `many` / `none` (with the parse tree; without it, a DML statement without `RETURNING` is `none`, `LIMIT 1` is `maybeOne`, anything else `many`). When in doubt it says `many`.

- INSERT / UPDATE / DELETE without `RETURNING` is `none`
- `INSERT ... RETURNING` with a single `VALUES` row is `one` (`maybeOne` with `ON CONFLICT DO NOTHING`)
- `LIMIT 1` is `maybeOne`
- A SELECT without `FROM` is `one` (`maybeOne` with a `WHERE`)
- A SELECT of aggregates only, without `GROUP BY`, is `one` (`maybeOne` with `HAVING`)
- A single-table SELECT / UPDATE / DELETE whose `WHERE` fixes every column of a unique key with `=` against a parameter or constant, joined by AND, is `maybeOne`

For now this is only part of the analysis; `run()` still returns `Row[]`. Surfacing it in the call API is under discussion (issue #5).

### 10.6 Go to definition

Each key of `Params` in the virtual module is mapped, as a span map Alias, to where that name first appears in the template (the name in `/*$name*/`, the collection of a `for`, an operand of an `if`), and each column of `Row` to the column name in the SELECT list. The rest maps as one Atom to the whole statement. Go to definition on `params.userId` is meant to land on the sigil (not yet verified in an editor).

### 10.7 Control flow and Row

`if` / `for` are expected inside WHERE, SET, VALUES, ORDER BY and LIMIT.
A branch inside the SELECT list is not tracked in v1; the sample rendering's shape is the `Row`.

## 11. Runtime API

```ts
import getById from "./sql/public/users/crud/get-by-id.sql";

getById.render({ id: 1 });             // { sql, params }
await getById.run(db, { id: 1 });      // Row[]
await getById.one(db, { id: 1 });      // Row (throws on 0 or 2+ rows)
await getById.maybeOne(db, { id: 1 }); // Row | null
await getById.exec(db, { id: 1 });     // void
getById.with(tx)                       // bound to a client
getById.raw                            // the template as written
```

- `db` is the user's `pg` / `postgres` client, pool or transaction.
- Value conversion is minimal; the driver's output is returned as-is.
- **Building the runtime module needs no database.** Parsing and rendering the template is enough to produce `defineQuery(...)`, so the load hook is synchronous and needs neither a cache nor a worker (a major difference from reylo). Only optional JSON Schema validation at run time would need the type-check analysis.

## 12. Open questions

- Whether to restrict `!` raw to a branded type (only through a `raw()` helper).
- How v2 handles `if` inside the SELECT list (enumerate branches, or forbid).
- When to allow nested `for`.
- Whether to allow literals in conditions (`status = 'active'`).
- When to adopt a parse tree (libpg-query wasm) for outer-join nullability and PK-match cardinality.
