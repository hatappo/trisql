# tysql

<p align="center"><code>tysql</code> (<code>táisikl</code>)</p>

2-way SQL templates as typed TypeScript queries. [日本語](./README_ja.md)

Write a `.sql` file that is valid, runnable SQL with sample values. Import it. Its parameters and rows are typed against your schema, with no code generation.

The name and the design are inspired by [bisql](https://github.com/hatappo/bisql), a 2-way SQL library for Clojure.

```sql
-- sql/get-user.sql
SELECT id, email, name
FROM users
WHERE id = /*$id*/1
```

```ts
import getUser from "./sql/get-user.sql";

const user = await getUser.maybeOne(db, { id: "1" });
// { id: string; email: string; name: string | null } | null
```

- Templates stay executable SQL (the [2-way SQL](./docs/2way-sql.md) style of bisql).
- Types come from a TypeScript 7.1 content mapper that describes each statement against an embedded PGlite loaded with your DDL. No database server has to be running.
- Bring your own driver: anything with `query(text, values)` returning `{ rows }`, such as `pg`, PGlite or Neon.
- PostgreSQL only for now.

Status: experimental. See [docs/2way-sql.md](./docs/2way-sql.md) for the template specification and [docs/differences-from-bisql.md](./docs/differences-from-bisql.md) for how it differs from bisql.

## Setup

Requirements: Node 24+, TypeScript 7.1 (beta or nightly), a `.sql` schema file (migrations or `pg_dump --schema-only`).

```sh
npm install tysql pg
npm install -D typescript@beta @electric-sql/pglite
npm install -D libpg-query   # optional: exact nullability for columns behind outer joins
```

```jsonc
// tysql.json
{ "schema": ["db/schema.sql"] }
// or, to type against a running database instead of the embedded PGlite:
// { "databaseUrl": "${DATABASE_URL}" }
```

```jsonc
// tsconfig.json
{
  "compilerOptions": { /* ... */ },
  "contentMappers": [{ "package": "tysql", "extensions": [".sql"] }]
}
```

```sh
tsc --noEmit --runExternalCode              # type check
node --import tysql/register main.ts        # run (plain Node)
npx tysql generate                          # write CRUD templates into sql/<schema>/<table>/crud/
```

With a bundler, add the plugin instead of the Node preload: `tysql/esbuild` (also for `Bun.build`) or `tysql/vite`.

## Development

```sh
npm run check   # lint, typecheck, tests
```
