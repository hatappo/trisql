// テスト用フィクスチャの `.sql` import に仮の型を与える（content mapper 導入までの暫定）。
declare module "*.sql" {
  import type { Query } from "tysql";

  const query: Query<Record<string, unknown>, Record<string, unknown>>;
  export const raw: string;
  export default query;
}
