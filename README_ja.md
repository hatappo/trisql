# trisql

<p align="center"><code>trisql</code>（<code>trάɪsɪkl</code>、トライシクル）</p>

2-way SQL のテンプレートを、型付きの TypeScript クエリとして使う。[English](./README.md)

サンプル値入りでそのまま実行できる `.sql` ファイルを書き、それを `import` する。パラメータと行の型はスキーマから導かれ、コード生成はない。

名前と設計は Clojure の 2-way SQL ライブラリ [bisql](https://github.com/hatappo/bisql) に着想を得ている。

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

- テンプレートは実行可能な SQL のまま（bisql の [2-way SQL](./docs/2way-sql_ja.md) スタイル）。
- 型は TypeScript 7.1 の content mapper が与える。DDL を適用した内包 PGlite に各文を Describe させるので、DB サーバーを起動しておく必要はない。
- ドライバは持ち込み。`query(text, values)` が `{ rows }` を返すものなら何でもよい（`pg`、PGlite、Neon など）。
- 対応 DB は当面 PostgreSQL のみ。

状態: 実験的。テンプレートの仕様は [docs/2way-sql_ja.md](./docs/2way-sql_ja.md)（[English](./docs/2way-sql.md)）、bisql との違いは [docs/differences-from-bisql_ja.md](./docs/differences-from-bisql_ja.md)（[English](./docs/differences-from-bisql.md)）を参照。

## セットアップ

必要なもの: Node 24 以上、TypeScript 7.1（beta または nightly）、スキーマの `.sql` ファイル（マイグレーション、または `pg_dump --schema-only` の出力）。

```sh
npm install trisql pg
npm install -D typescript@beta @electric-sql/pglite
npm install -D libpg-query   # 任意。外部結合の先にある列の nullability を正確にする
```

```jsonc
// trisql.json
{ "schema": ["db/schema.sql"] }
// 内包 PGlite ではなく稼働中の DB に対して型付けするなら:
// { "databaseUrl": "${DATABASE_URL}" }
```

```jsonc
// tsconfig.json
{
  "compilerOptions": { /* ... */ },
  "contentMappers": [{ "package": "trisql", "extensions": [".sql"] }]
}
```

```sh
tsc --noEmit --runExternalCode              # 型チェック
node --import trisql/register main.ts        # 実行（素の Node）
npx trisql generate                          # CRUD テンプレートを sql/<schema>/<table>/crud/ に生成
```

バンドラを使う場合は Node のプリロードの代わりにプラグインを追加する: `trisql/esbuild`（`Bun.build` も同じ）または `trisql/vite`。

## 開発

```sh
npm run check   # lint、型チェック、テスト
```
