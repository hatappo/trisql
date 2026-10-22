# Spikes

実装前の技術検証。本体のコードではない。

- `mapper/`: TypeScript 7.1 content mapper の最小実装。`mapper-pkg/` が mapper、`app/` が利用側。
  `cd app && npm install && npx tsc --noEmit --runExternalCode` で確認。プロトコルのログは `mapper-pkg/mapper.log`。
- `pglite/`: PGlite に DDL を適用し、`execProtocol` で Parse/Describe/Sync を送って
  パラメータ型 OID と列の由来テーブル OID / 列番号を取る検証。`npm install && node describe.mjs`。

注意: このマシンの npm は `min-release-age=3` で公開 3 日未満の版を拒否するため、
TypeScript は `7.1.0-dev.20261019.1`、PGlite は `0.5.10` を使っている。
