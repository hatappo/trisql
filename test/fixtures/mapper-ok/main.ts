import { ALL, LIKE_CONTAINS } from "tysql";
import getUser from "./sql/get-user.sql";
import insertUser from "./sql/insert-user.sql";
import searchUsers from "./sql/search-users.sql";

declare const db: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };

const user = await getUser.maybeOne(db, { id: "1" });
if (user) {
  const email: string = user.email;
  const name: string | null = user.name;
  const status: "active" | "inactive" = user.status;
  console.log(email, name, status);
}
const found = await searchUsers.run(db, { q: LIKE_CONTAINS("ali"), limit: ALL });
const first = found[0];
if (first) console.log(first.id, first.email);
await searchUsers.run(db, { limit: "5" });
await insertUser.exec(db, { email: "b@example.com", name: "Bob" });

// 生成した CRUD テンプレート
import { getById, insert, listByEmailStartingWith, updateById, upsertByEmail } from "./sql/public/users/crud/index.ts";

const created = await insert.one(db, { email: "c@example.com" });
const fetched = await getById.maybeOne(db, { id: created.id });
if (fetched) console.log(fetched.email, fetched.status);
await updateById.one(db, { where: { id: created.id }, updates: { name: "C" } });
await upsertByEmail.one(db, { inserts: { email: "c@example.com" }, updates: { status: "inactive" } });
await upsertByEmail.one(db, { inserts: { email: "d@example.com" } });
const prefixed = await listByEmailStartingWith.run(db, { email: LIKE_CONTAINS("c"), limit: 5 });
console.log(prefixed.length);
