# Differences from bisql

trisql ports the ideas of [bisql](https://github.com/hatappo/bisql), a 2-way SQL library for Clojure, to TypeScript.
They share three principles: query functions are generated from valid SQL files, there is no query builder and no data mapper, and generated CRUD and hand-written SQL have the same shape.

This document covers **differences only**. The full specification is in [2way-sql.md](./2way-sql.md).

## 1. Positioning

| Aspect | bisql | trisql |
|---|---|---|
| Language | Clojure (renderer in cljc, shared with ClojureScript) | TypeScript |
| Source of types | Declaration comments (`:malli/in`, `:malli/out`); attached to generated CRUD, optional for hand-written SQL | Derived at type-check time by Describe against a database (embedded PGlite by default, a real database optionally) |
| How functions appear | The `(defquery)` macro scans `sql/` on the classpath and defines vars | A TypeScript 7.1 content mapper types `import "./x.sql"`; a load hook builds the runtime module |
| Runtime validation | Malli (`:malli/in`, `:malli/out`) | JSON Schema generated from the analysis, no declarations |
| Execution adapter | `next.jdbc` | Bring your own driver (`pg`, `postgres`) |
| Databases | PostgreSQL (others planned) | PostgreSQL (SQLite / MySQL later) |
| Database connection | At run time, and for `gen-crud` | Also at type-check time, but by default DDL is applied to an embedded PGlite, so no server has to be running |

## 2. File units and naming

| Aspect | bisql | trisql |
|---|---|---|
| Queries per file | Several, separated by `/*:name*/` | One. `/*:name*/` does not exist |
| Where generated CRUD lives | One `crud.sql` per table holding every query | One file per query in a directory per table, plus a generated barrel `index.ts` |
| Layout convention | `sql/<dialect>/<schema>/<table>/<ns-suffix>.<fn>.sql` becomes the namespace and function name | None. The file path is the identity |
| Function name | The file name (a kebab-case Clojure symbol) | The default export; the barrel converts to camelCase |
| Generated schema file | `schema.clj` (Malli schemas) | None |

## 3. Declaration comments

| Declaration | bisql | trisql |
|---|---|---|
| `name` | Separates queries in a file | None |
| `doc` | Optional, plain text or EDN | Optional, plain text only |
| `cardinality` | Declared as `:one` etc. | None. Chosen by calling `run` / `one` / `maybeOne` / `exec` |
| `malli/in`, `malli/out` | Attached to generated CRUD, optional for hand-written SQL | None. Derived from the database |
| Arbitrary keys (tags etc.) | Allowed, parsed as EDN into `:meta` | Not allowed. Anything but `doc` is an error |
| Body format | EDN | Plain text |

## 4. Parameters and rendering

| Aspect | bisql | trisql |
|---|---|---|
| Parameter names | Clojure keywords, kebab-case allowed (`/*$order-by*/`) | JavaScript identifiers, camelCase recommended, kebab-case not allowed |
| Nested access | Dot path (`item.value`), looked up by keyword, string or symbol | Dot path, object properties only |
| Placeholders | `?` (JDBC) | `$n` (PostgreSQL); the same name reuses the same `$n` |
| Not-given values | Only a missing key is "not given"; `nil` is an explicit NULL | `undefined` and a missing key are "not given"; `null` is an explicit NULL |
| `DEFAULT`, `ALL` | `bisql/DEFAULT`, `bisql/ALL` (sentinel objects) | Unique symbols that appear in the `Params` union |
| LIKE helpers | `LIKE_STARTS_WITH` etc. return a `LikePattern` record | Same-named functions return a branded type that appears in the `Params` union |
| `'` inside a `^` literal | Error | Doubled to `''` |
| Sigil comment with no sample directly after it | Treated as ordinary text | Error |
| Result column names | Converted to kebab-case keywords (`:display-name`) | Kept as snake_case (`display_name`) |
| Value conversion | JDBC helpers such as `->timestamp` | None; left to the driver |

## 5. Control flow

| Aspect | bisql | trisql |
|---|---|---|
| Truthiness | Clojure's (only `nil` and `false` are falsy) | Only `null` / `undefined` / `false` are falsy (JavaScript truthiness is not used) |
| Comparison `=` | Clojure value equality (collections compare too) | `===`; comparing objects is undefined |
| `for` collection | sequential or map | array or `Record<string, T>` |
| Nested `for` | Not supported | Not supported (v1) |
| Everything else (`if` / `elseif` / `else` / `=>` / `separating` / WHERE and AND cleanup / `default-to`) | | Same |

## 6. Typing pipeline

bisql:

1. `gen-crud` reads the database schema, writes `crud.sql` and `schema.clj`, and embeds `:malli/in` / `:malli/out` declarations
2. `(defquery)` reads the SQL at macro-expansion time and attaches the declarations as var metadata
3. Malli validates at run time (depending on the configured mode)

trisql:

1. At type-check time the content mapper analyzes each `.sql`. The DDL is applied to an embedded PGlite (or a real database is used), and Parse/Describe plus catalog queries yield parameter types, column types and nullability
2. The result is returned to tsc as a virtual `.ts` module, so `Params` and `Row` appear at the import site
3. At run time a load hook or bundler plugin builds a `defineQuery(...)` module from the same analysis. No declarations are involved

## 7. Implementation differences

| Aspect | bisql | trisql |
|---|---|---|
| Parser | Regex-based; does not account for `/*$` inside string literals and the like | A tokenizer with positions; skips strings, `--`, `$$` dollar quoting and `E''`. Offsets are needed for the content mapper's span map and diagnostics |
| Renderer | Renderer functions generated by `eval` or interpreted from the analysis | A pure function `render(template, params)` |
| Playground | ClojureScript in the browser | Not planned (possible, since the renderer is pure) |

## 8. Not carried over from bisql

- `/*:name*/` and multi-query files
- The `:cardinality` declaration (moved to the call API)
- `:malli/*` declarations and `schema.clj`
- EDN
- kebab-case parameter and result column names
- The JDBC-style `?` placeholder and time helpers
