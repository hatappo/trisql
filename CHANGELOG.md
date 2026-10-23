# Changelog

## 0.1.0-alpha.3

- `trisql generate` writes every table under `<out>/<schema>/<table>/crud/`; `public` is no longer special (#7).
- Hovering an imported query shows the shapes of its parameters and rows instead of `Query<Params, Row>` (#14).
- The analysis and generator internals are available from `trisql/experimental`, outside semver (#16).
- Fix: `trisql generate` no longer closes the database while it is still analyzing; `dist/cli.js` is executable (#9).
- CI runs lint, typecheck and tests on every pull request (#17).

`0.1.0-alpha.2` was tagged but never published. It contained experimental declaration files (`.d.sql.ts`), which were removed in #15.

## 0.1.0-alpha.1

First alpha: 2-way SQL templates typed by a TypeScript 7.1 content mapper against an embedded PGlite or a running PostgreSQL, a runtime with `run` / `one` / `maybeOne` / `exec`, `node --import trisql/register`, esbuild and Vite plugins, CRUD generation, and outer-join nullability and cardinality from the parse tree.
