import getUser from "./sql/get-user.sql";

declare const db: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

// 意図的な型エラー: Params に無いキー
await getUser.run(db, { nope: 1 });
// 意図的な型エラー: id は string（int8）
await getUser.run(db, { id: 1 });
// 意図的な型エラー: Row に無い列
const u = await getUser.one(db, { id: "1" });
console.log(u.missing);
