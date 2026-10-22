# tysql

2-way SQL templates as typed TypeScript queries.

Write a `.sql` file that is valid, runnable SQL with sample values. Import it. Its parameters and rows are typed against your schema, with no code generation.

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

- Templates stay executable SQL (the [2-way SQL](./docs/2way-sql.md) style of [bisql](https://github.com/hatappo/bisql)).
- Types come from a TypeScript 7.1 content mapper that describes each statement against an embedded PGlite loaded with your DDL. No database server has to be running.
- Bring your own driver: anything with `query(text, values)` returning `{ rows }`, such as `pg`, PGlite or Neon.
- PostgreSQL only for now.

Status: experimental. See [docs/2way-sql.md](./docs/2way-sql.md) ([日本語](./docs/2way-sql_ja.md)) for the template specification and [docs/differences-from-bisql.md](./docs/differences-from-bisql.md) ([日本語](./docs/differences-from-bisql_ja.md)) for how it differs from bisql.

## Setup

Requirements: Node 24+, TypeScript 7.1 (beta or nightly), a `.sql` schema file (migrations or `pg_dump --schema-only`).

```sh
npm install tysql pg
npm install -D typescript@beta @electric-sql/pglite
```

```jsonc
// tysql.json
{ "schema": ["db/schema.sql"] }
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
node --import tysql/register main.ts        # run
npx tysql generate                          # write CRUD templates into sql/<table>/crud/
```

## Development

```sh
npm run check   # lint, typecheck, tests
```
