# tysql の 2-way SQL 仕様

状態: 設計段階のドラフト（2026-10-23）。実装に合わせて更新する。
bisql との差分だけを知りたい場合は [differences-from-bisql_ja.md](./differences-from-bisql_ja.md) を参照。

## 1. 原則

- **テンプレートは valid な SQL である。** サンプル値が入った状態でそのまま PostgreSQL で実行できる。
- **ブロックコメントだけがテンプレート構文である。** コメントを全部無視すると普通の SQL が残る。
- **1 ファイル 1 クエリ。** ファイルパスがクエリの識別子で、`import` の default export になる。
- **宣言は最小限。** 型は SQL 本文と DB（既定は内包 PGlite）から導く。宣言コメントは `doc` のみ。
- **行数（cardinality）は SQL 側ではなく TypeScript 側の呼び出し API で選ぶ。**
- **対象 DB は PostgreSQL。** プレースホルダは `$n`。

## 2. sigil

ブロックコメントの先頭 1 文字を sigil として予約する。

| sigil | 形 | 役割 |
|---|---|---|
| `$` | `/*$name*/sample` | バインド変数。`$n` に描画される |
| `^` | `/*^name*/sample` | リテラル。値を SQL リテラルとして埋め込む |
| `!` | `/*!name*/sample` | raw。値を SQL 断片としてそのまま埋め込む |
| `%` | `/*%if ... */` など | 制御構文（if / elseif / else / end / for） |
| `:` | `/*:doc ... */` | 宣言（`doc` のみ） |

通常のコメントは sigil で始めない。`/* ... */`（先頭に空白）または `/** ... */` を使う。
`--` の行コメントは常に通常コメントで、テンプレート構文を含まない。
通常コメントは描画後の SQL にそのまま残る。

## 3. バインド変数 `$`

```sql
SELECT * FROM users WHERE id = /*$id*/1
```

```ts
render({ id: 42 })
// { sql: "SELECT * FROM users WHERE id = $1", params: [42] }
```

### 3.1 名前

- JS の識別子（`[A-Za-z_][A-Za-z0-9_]*`）。camelCase を推奨する。kebab-case は使えない。
- dot path（`/*$where.id*/`、`/*$item.value*/`）は入れ子オブジェクトの参照。
- 同じ名前が複数回出てきても同じ `$n` を再利用する。

### 3.2 サンプル値

コメント直後に置く。空白を挟まない。次のいずれか。

- 文字列リテラル `'...'`（内部の `''` を含めて 1 トークン）
- 数値、`true` / `false` / `NULL`、`DEFAULT`、`CURRENT_TIMESTAMP` のような区切り文字までの 1 トークン
- 括弧で囲まれたコレクション `(1, 2, 3)`（入れ子の括弧を許す）
- dollar quoting `$$...$$` も 1 トークンとして扱う

サンプルの直後に続く `::type` キャストは SQL に残る。

```sql
WHERE created_at > /*$since*/'2024-01-01'::timestamptz
-- → WHERE created_at > $1::timestamptz
```

これは Describe によるパラメータ型付けに直接効くので、型が曖昧な箇所ではキャストを書くことを推奨する。

### 3.3 コレクションバインド

```sql
WHERE id IN /*$ids*/(1, 2, 3)
```

```ts
render({ ids: [10, 20, 30] })
// { sql: "WHERE id IN ($1, $2, $3)", params: [10, 20, 30] }
```

- 値は配列でなければならない。空配列はエラー。
- 配列の要素に `DEFAULT`、`ALL`、LIKE ヘルパは使えない。

### 3.4 `undefined` と `null`

- `undefined`（キーがない場合も同じ）は **未指定**。`default-to` があれば fallback、なければエラー。
- `null` は **明示的な NULL** としてバインドする。

### 3.5 `default-to`

```sql
INSERT INTO users (id, email)
VALUES (/*$id default-to */DEFAULT, /*$email*/'user@example.com')
```

パラメータが未指定ならサンプル SQL 断片（この例では `DEFAULT`）をそのまま使う。
`default-to` が付いたパラメータは Params 型で optional になる。
`$` バインドにのみ付けられる。

### 3.6 特殊値

- `DEFAULT`、`ALL`: tysql が export する unique symbol。渡すと `$n` ではなく SQL キーワード `DEFAULT` / `ALL` を描画する。スカラーの `$` バインドのみ。
- `LIKE_STARTS_WITH(s)`、`LIKE_ENDS_WITH(s)`、`LIKE_CONTAINS(s)`: `%`、`_`、`\` をエスケープし適切な位置に `%` を付けた値をバインドする。SQL 側には `ESCAPE '\'` を書くこと。

```sql
WHERE name LIKE /*$search*/'foo%' ESCAPE '\'
```

```ts
render({ search: LIKE_CONTAINS("100%") })
// params: ["%100\\%%"]
```

## 4. リテラル `^`

```sql
WHERE type = /*^type*/'A'
```

```ts
render({ type: "BOOK" })
// { sql: "WHERE type = 'BOOK'", params: [] }
```

- 文字列は `'` で囲み、内部の `'` は `''` に二重化する。
- 数値はそのまま埋め込む。
- それ以外の型はエラー。
- プリペアドステートメントのキャッシュを分けたい場合など、バインドでは目的を果たせない箇所にだけ使う。

## 5. raw `!`

```sql
ORDER BY /*!orderBy*/created_at DESC
```

```ts
render({ orderBy: "updated_at ASC" })
// { sql: "ORDER BY updated_at ASC", params: [] }
```

- 値は文字列で、検証なしにそのまま埋め込む。
- **ユーザー入力を直接渡してはならない。** 呼び出し側で許可リストに照合すること。
- `for` ブロックで `Record` のキーを列名として使う場合は、識別子（`[A-Za-z_][A-Za-z0-9_]*`）であることを検証する。

## 6. 制御構文 `%`

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

本文はインラインでも書ける。

```sql
/*%if active */
  active = true
/*%elseif pending => status = 'pending' */
/*%else => status = 'inactive' */
/*%end */
```

インラインとブロック本文を同じ分岐で混在させることはできない。
`else` の後に `elseif` は置けない。`else` は 1 つまで。

### 6.2 条件式

小さな式言語。

- 論理演算子 `and`、`or`
- 比較演算子 `=`、`!=`、`<`、`<=`、`>`、`>=`
- 括弧
- オペランドはパラメータ参照のみ。dot path 可。リテラル、算術、関数呼び出し、`not` は不可
- 裸の識別子は真偽判定

優先順位は 比較 > `and` > `or`。

真偽判定の規則:

- **偽は `null`、`undefined`、`false` のみ。** `0`、`""`、`NaN`、空配列は真。
- 比較は `===` による。オブジェクト同士の比較は未定義。

### 6.3 for

```sql
UPDATE users
SET
/*%for item in updates separating , */
  /*!item.name*/display_name = /*$item.value*/'sample'
/*%end */
WHERE id = /*$id*/1
```

- `separating <sep>` で要素間の区切りを指定する。省略時は区切りなし。
- コレクションは配列、または `Record<string, T>`。`Record` の場合は `{ name: key, value }` の配列として扱い、キーは識別子であることを検証する。
- `for` の中に `if` は書ける。`for` の入れ子は v1 では不可。

### 6.4 空になった句の後始末

分岐や繰り返しの結果、句が空になった場合に次を行う。

- 直前の `WHERE` / `HAVING` が空になれば、そのキーワードを除去する。
- 直後に `AND` / `OR` が続く場合は、その接続詞を除去する。
- `SET` / `VALUES` の直後が空になる場合はエラー（空の `SET` は valid でない）。

## 7. 宣言 `:`

テンプレートの先頭にのみ置ける。現在は `doc` のみ。

```sql
/*:doc ユーザーを id で 1 件取得する */
SELECT * FROM users WHERE id = /*$id*/1
```

- ボディは平文。複数行可。生成される型の JSDoc に載る。
- `doc` 以外の宣言はエラー。`/*: */` は将来の拡張のために予約する。

## 8. ファイル配置

- 1 ファイル 1 クエリ。1 ファイルに複数の文を書けない。
- `import q from "./users/get-by-id.sql"` の default export がクエリ。
- 配置規約は強制しない。CRUD 生成はテーブルごとのディレクトリにクエリを展開し、barrel（`index.ts`）を併せて生成する。

```text
sql/users/crud/get-by-id.sql
sql/users/crud/list-by-email.sql
sql/users/crud/index.ts   // export { default as getById } from "./get-by-id.sql"; ...
```

## 9. CRUD 生成

`tysql generate` は設定の DDL を内包 PGlite に適用し、テーブルごとに index-friendly な CRUD テンプレートを生成する。

```jsonc
// tysql.json
{ "schema": ["db/schema.sql"], "generate": { "out": "sql", "schemas": ["public"] } }
```

出力先は `<out>/<table>/crud/<query>.sql`（`public` 以外のスキーマは `<out>/<schema>/<table>/crud/`）。
併せて `index.ts`（barrel）を生成し、`import { getById } from "./sql/users/crud"` と書ける。
`crud/` ディレクトリは生成器が所有し、今回生成しなかった `.sql` と `index.ts` は削除する。

生成されるクエリ:

| 名前 | 内容 |
|---|---|
| `insert`、`insert-many` | 挿入可能な全列。default や identity を持つ列と nullable な列は `default-to` で optional。`RETURNING *` |
| `get-by-<unique>`、`delete-by-<unique>` | 主キーと各ユニークキーによる 1 件取得・削除 |
| `update-by-<unique>` | `where` と `updates`（`for` ループ）による部分更新 |
| `upsert-by-<unique>` | `inserts` と `updates`。`updates` が未指定なら `DO NOTHING` |
| `list`、`list-by-<index prefix>` | 主キー順の一覧と、インデックスの各接頭辞による一覧。残りの列で `ORDER BY`。`LIMIT` 付き |
| `list-by-<...>-starting-with`、`count-by-<...>-starting-with` | 末尾が文字列列のインデックスに対する前方一致（`LIKE ... ESCAPE`） |
| `count`、`count-by-<index prefix>` | 件数 |

生成列（`GENERATED ALWAYS AS`）と `GENERATED ALWAYS AS IDENTITY` の列は挿入対象から外す。
複数列の名前は `-and-` で結合し、列名の `_` は `-` にする。

## 10. 型付け

型チェック時、content mapper が各テンプレートを解析して `Params` と `Row` を決める。

### 10.1 情報源

- 既定: 設定で指定した DDL（マイグレーションまたは `schema.sql`）を内包 PGlite に適用し、Parse/Describe とカタログ照会を行う。
- `databaseUrl` 指定時: その PostgreSQL に同じ問い合わせを行う。
- 両者は同じ `Describer` インターフェースで抽象化され、同じ解析結果を返す。

### 10.2 正準描画（canonical rendering）

Describe は 1 文しか受け付けないので、テンプレートから「正準描画」を 1 つ作って送る。

- `$` はサンプルを `$n` に置き換える。直後の `::type` は残す
- `default-to` 付きの箇所も `$n` にする（型を得るため）
- `^` と `!` はサンプルをそのまま残す
- `if` は **最初の分岐（`if` 本文）だけ** を採用し、`elseif` / `else` は落とす
- `for` は本文を 1 回だけ描画する
- 通常コメントは残す

「生ファイルが valid な SQL である」ことと「正準描画が valid である」ことが同値になるように定義する。
そのため `elseif` / `else` の本文はインライン（`=>`）で書くことを推奨する。ブロック本文で書くと生ファイル自体が valid でなくなる。

`elseif` / `else` の中にしか出てこないパラメータは Describe の型を得られないので、サンプルリテラルの型にフォールバックする。
分岐ごとの描画を追加で Describe するのは v2 の検討事項。

正準描画の各文字がテンプレートのどの offset に由来するかの対応表を保持し、Postgres のエラー位置（`position`）や列名の位置をテンプレート上に投影する。

### 10.3 Params

| 出現箇所 | 型 | optional |
|---|---|---|
| `$` スカラー | サンプルの直後のキャスト > Describe のパラメータ型 > サンプルリテラルの型 | `default-to` 付きなら optional |
| `$` の入力型は出力型より広い | `int8` `numeric` は `string | number | bigint`、日時は `Date | string`、`bytea` は `Buffer | Uint8Array` | |
| `$` コレクション | 要素型の配列 | 同上 |
| `if` の分岐内の `$` / `^` / `!` | 同上 | optional（分岐が選ばれたときだけ要る） |
| `^` | サンプルの型（`string` または `number`） | なし |
| `!` | `string` | なし |
| `if` の裸の識別子（他で未使用） | `boolean \| null \| undefined` | optional |
| `if` の比較オペランド（他で未使用） | `unknown` | optional |
| `if` のオペランドで、他の `$` でも使われる名前 | その `$` の型 | その `$` に従う |
| `for item in xs` の `xs` | `Array<{...}>` または `Record<string, T>`。本文の `item.*` の使われ方から要素型を組む | なし |

`DEFAULT` / `ALL` / LIKE ヘルパを受け付ける箇所は、その型が union に加わる。

### 10.4 Row

- 列の名前と型は Describe の RowDescription から。列名は snake_case のまま。
- 型 OID から TS 型への対応は `pg`（node-postgres）の既定の出力に合わせる。`int2` `int4` `float4` `float8` は `number`、`int8` `numeric` は `string`、`text` `varchar` `uuid` は `string`、`bool` は `boolean`、`date` `timestamp` `timestamptz` は `Date`、`json` `jsonb` は `unknown`、`bytea` は `Buffer`、enum はラベルの union、配列は要素型の配列。それ以外は `unknown`。
- PGlite は `int8` を `BigInt`（安全な範囲なら `number`）で返すなど `pg` と異なるが、型表は `pg` を基準にする。
- nullability は由来テーブルの `pg_attribute.attnotnull` から。式由来の列（由来テーブルなし）は nullable。
- 文に `LEFT JOIN` / `RIGHT JOIN` / `FULL JOIN` が含まれる場合、FROM の先頭以外のテーブル由来の列は保守的に nullable とする。（将来、構文木を導入して正確に判定する）
- `RETURNING` のない DML は `Row` を持たない。

### 10.5 定義ジャンプ

仮想モジュールの `Params` の各キーは、テンプレート上でその名前が最初に現れる位置（`/*$name*/` の名前、`for` のコレクション名、`if` の条件のオペランド）に、`Row` の各列名は SELECT リスト内の列名に、span map の Alias として対応づける。残りは文全体への Atom。エディタで `params.userId` から該当の sigil へ定義ジャンプできる想定（実機での確認は未了）。

### 10.6 制御構文と Row

`if` / `for` は WHERE、SET、VALUES、ORDER BY、LIMIT 内で使う前提。
SELECT リストの中で使った場合の列形状の変化は v1 では追わず、サンプル描画の形を `Row` とする。

## 11. ランタイム API

```ts
import getById from "./sql/users/crud/get-by-id.sql";

getById.render({ id: 1 });          // { sql, params }
await getById.run(db, { id: 1 });   // Row[]
await getById.one(db, { id: 1 });   // Row（0 行・2 行以上は例外）
await getById.maybeOne(db, { id: 1 }); // Row | null
await getById.exec(db, { id: 1 }); // void
getById.with(tx)                    // クライアント束縛版
getById.raw                         // テンプレート原文
```

- `db` はユーザーが用意する `pg` / `postgres` のクライアント、プール、トランザクション。
- 結果の値変換は最小限で、ドライバの出力をそのまま返す。
- **実行用モジュールの生成に DB は不要。** テンプレートの解析と描画だけで `defineQuery(...)` を作れるので、ロードフックは同期的に動き、キャッシュも worker も要らない（reylo との大きな違い）。JSON Schema による実行時検証を付ける場合だけ型チェックの解析結果が要る。

## 12. 未決事項

- `!` raw をブランド型（`raw()` ヘルパ経由のみ）に限定するか。
- SELECT リスト内の `if` を v2 でどう扱うか（分岐列挙か、禁止か）。
- `for` の入れ子をいつ許すか。
- 条件式にリテラル（`status = 'active'`）を許すか。
- 構文木（libpg-query の wasm）を導入する時期と、外部結合・PK 一致の判定への利用。
