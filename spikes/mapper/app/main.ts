import getUser from "./sql/get-user.sql";

const rows = await getUser.run({ userId: 1 });
const email: string | null = rows[0]!.email;
// 意図的な型エラー: Params に存在しないキー
await getUser.run({ nope: 1 });
// 意図的な型エラー: Row に無い列
const x: number = rows[0]!.missing;
console.log(email, x);
