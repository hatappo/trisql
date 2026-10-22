# bisql との違い

tysql は [bisql](https://github.com/hatappo/bisql)（Clojure 製 2-way SQL ライブラリ）の思想を TypeScript に移植したもの。
共通する思想は「valid な SQL ファイルからクエリ関数を生成する」「クエリビルダもデータマッパも持たない」「生成 CRUD も手書き SQL も同じ形」の 3 点。

この文書は **違い** だけを扱う。仕様の全体は [2way-sql_ja.md](./2way-sql_ja.md) を参照。

## 1. 位置づけの違い

| 観点 | bisql | tysql |
|---|---|---|
| 言語 | Clojure（レンダラは cljc で ClojureScript 共用） | TypeScript |
| 型の出どころ | 宣言コメント（`:malli/in` `:malli/out`）。生成 CRUD には自動付与、手書きは任意 | 型チェック時に DB（既定は内包 PGlite、任意で実 DB）に Describe して導出 |
| 関数化の仕組み | `(defquery)` マクロがクラスパス上の `sql/` を走査して var を定義 | TypeScript 7.1 content mapper が `import "./x.sql"` に型を与え、ロードフックが実行用モジュールを作る |
| 実行時検証 | Malli（`:malli/in` `:malli/out`） | 解析結果から生成する JSON Schema（宣言不要） |
| 実行アダプタ | `next.jdbc` | ドライバはユーザー持ち（`pg`、`postgres`） |
| 対象 DB | PostgreSQL（他は計画） | PostgreSQL（SQLite / MySQL は将来） |
| DB 接続 | 実行時のみ。生成 CRUD の `gen-crud` 時にも必要 | 型チェック時にも必要。ただし既定は内包 PGlite に DDL を流すので、サーバー起動は不要 |

## 2. ファイル単位と命名

| 観点 | bisql | tysql |
|---|---|---|
| 1 ファイルのクエリ数 | 複数可。`/*:name*/` で区切る | 1 つ。`/*:name*/` は存在しない |
| 生成 CRUD の置き場 | テーブルごとに 1 つの `crud.sql` に全クエリをまとめる | テーブルごとのディレクトリに 1 クエリ 1 ファイルで展開し、barrel `index.ts` を生成 |
| 配置規約 | `sql/<dialect>/<schema>/<table>/<ns-suffix>.<fn>.sql` が名前空間と関数名になる | 規約なし。ファイルパスが識別子 |
| 関数名 | ファイル名（kebab-case の Clojure シンボル） | default export。barrel では camelCase に変換 |
| 生成されるスキーマファイル | `schema.clj`（Malli スキーマ） | なし |

## 3. 宣言コメント

| 宣言 | bisql | tysql |
|---|---|---|
| `name` | 複数クエリの区切り | なし |
| `doc` | 任意。平文または EDN | 任意。平文のみ |
| `cardinality` | `:one` などを宣言 | なし。`run` / `one` / `maybeOne` / `exec` の呼び分けで選ぶ |
| `malli/in` `malli/out` | 生成 CRUD に付与、手書きは任意 | なし。DB から導出 |
| 任意のキー（tags など） | 可。EDN として `:meta` に載る | 不可。`doc` 以外はエラー |
| ボディの形式 | EDN | 平文 |

## 4. パラメータとレンダリング

| 観点 | bisql | tysql |
|---|---|---|
| パラメータ名 | Clojure キーワード。kebab-case 可（`/*$order-by*/`） | JS 識別子。camelCase 推奨。kebab-case 不可 |
| 入れ子参照 | dot path（`item.value`）。キーワード / 文字列 / シンボルのいずれでも引ける | dot path。オブジェクトのプロパティのみ |
| プレースホルダ | `?`（JDBC） | `$n`（PostgreSQL）。同名は同じ `$n` を再利用 |
| 未指定の値 | キーが無いときのみ未指定。`nil` は明示的な NULL | `undefined` とキー無しは未指定。`null` は明示的な NULL |
| `DEFAULT` `ALL` | `bisql/DEFAULT` `bisql/ALL`（センチネルオブジェクト） | unique symbol。Params 型の union に現れる |
| LIKE ヘルパ | `LIKE_STARTS_WITH` などが `LikePattern` レコードを返す | 同名の関数がブランド型を返す。Params 型の union に現れる |
| `^` リテラルの `'` | 含む文字列はエラー | `''` に二重化 |
| 結果の列名 | kebab-case キーワードに変換（`:display-name`） | snake_case のまま（`display_name`） |
| 値の変換 | `->timestamp` などの JDBC ヘルパ | なし。ドライバに委ねる |

## 5. 制御構文

| 観点 | bisql | tysql |
|---|---|---|
| 真偽判定 | Clojure の truthiness（`nil` と `false` だけが偽） | `null` / `undefined` / `false` だけが偽（JS の truthiness は採らない） |
| 比較 `=` | Clojure の値等価（コレクションも比較できる） | `===`。オブジェクト同士は未定義 |
| `for` のコレクション | sequential または map | 配列または `Record<string, T>` |
| `for` の入れ子 | 不可 | 不可（v1） |
| その他（`if` / `elseif` / `else` / `=>` / `separating` / WHERE と AND の後始末 / `default-to`） | | 同じ |

## 6. 型付けの流れ

bisql:

1. `gen-crud` が DB スキーマを読んで `crud.sql` と `schema.clj` を生成し、`:malli/in` `:malli/out` を宣言として埋め込む
2. `(defquery)` がマクロ展開時に SQL を読み、宣言をメタデータとして var に付ける
3. 実行時に Malli で検証する（モード設定による）

tysql:

1. 型チェック時、content mapper が各 `.sql` を解析する。DDL を内包 PGlite に適用（または実 DB に接続）し、Parse/Describe とカタログ照会でパラメータ型、列型、nullability を得る
2. その結果を仮想 `.ts` モジュールとして tsc に返す。`Params` と `Row` が import 側に現れる
3. 実行時はロードフックまたはバンドラプラグインが同じ解析結果から `defineQuery(...)` モジュールを作る。宣言は介在しない

## 7. 実装上の違い

| 観点 | bisql | tysql |
|---|---|---|
| パーサ | 正規表現ベース。文字列リテラル内の `/*$` などは考慮しない | 位置情報付きトークナイザ。文字列、`--`、`$$` dollar quoting、`E''` を読み飛ばす。content mapper の span map と診断に offset が必要 |
| レンダラ | 解析結果からレンダラ関数を `eval` またはインタプリタで生成 | 純粋関数 `render(template, params)` |
| Playground | ClojureScript でブラウザ実行 | 計画なし（レンダラは純粋関数なので可能） |

## 8. bisql から引き継がないもの

- `/*:name*/` と複数クエリファイル
- `:cardinality` 宣言（呼び出し API に移す）
- `:malli/*` 宣言と `schema.clj`
- EDN
- kebab-case のパラメータ名と結果列名
- JDBC 由来の `?` プレースホルダと時刻ヘルパ
