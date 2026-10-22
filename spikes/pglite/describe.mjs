import { PGlite } from "@electric-sql/pglite";
import { serialize } from "pg-protocol";

const db = new PGlite();
await db.waitReady;
await db.exec(`
  CREATE TYPE status AS ENUM ('active', 'inactive');
  CREATE TABLE users (
    id bigserial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text,
    status status NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE posts (
    id serial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    title text NOT NULL
  );
`);

async function describe(sql) {
  const msg = Buffer.concat([
    serialize.parse({ name: "", text: sql, types: [] }),
    serialize.describe({ type: "S", name: "" }),
    serialize.sync(),
  ]);
  const out = { params: [], columns: [], error: undefined };
  let messages;
  try { ({ messages } = await db.execProtocol(msg)); } catch (e) { out.error = { message: e.message, code: e.code, position: e.position, hint: e.hint }; return out; }
  for (const m of messages) {
    if (m.name === "parameterDescription") out.params = m.dataTypeIDs;
    else if (m.name === "rowDescription") out.columns = m.fields.map((f) => ({ name: f.name, oid: f.dataTypeID, table: f.tableID, attnum: f.columnID }));
    else if (m.name === "noData") out.columns = [];
    else if (m.name === "error") out.error = { message: m.message, code: m.code, position: m.position };
  }
  return out;
}

const q1 = await describe(`SELECT u.id, u.email, u.name, u.status, p.title, count(*)::int AS n
  FROM users u LEFT JOIN posts p ON p.user_id = u.id
  WHERE u.id = $1 AND u.created_at > $2::timestamptz GROUP BY u.id, p.title`);
console.log("Q1", JSON.stringify(q1, null, 1));

const q2 = await describe(`INSERT INTO users (email, name) VALUES ($1, $2)`);
console.log("Q2", JSON.stringify(q2));

const q3 = await describe(`SELECT nope FROM users`);
console.log("Q3", JSON.stringify(q3));

// catalog: NOT NULL and type names for Q1 columns
const rels = [...new Set(q1.columns.filter((c) => c.table).map((c) => c.table))];
const cat = await db.query(
  `SELECT a.attrelid::int AS rel, a.attnum, a.attname, a.attnotnull, t.typname, t.typtype, c.relname
     FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_class c ON c.oid = a.attrelid
    WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY rel, attnum`,
  [rels],
);
console.log("CATALOG", JSON.stringify(cat.rows));
const enums = await db.query(`SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`);
console.log("ENUMS", JSON.stringify(enums.rows));
const ver = await db.query(`SELECT version()`);
console.log("VERSION", ver.rows[0].version);
await db.close();
