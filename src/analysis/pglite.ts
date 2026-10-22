/**
 * 内包 PGlite による Describer。DDL を適用した上で Parse / Describe / Sync を送る。
 */
import type { PGlite } from "@electric-sql/pglite";
import { TysqlError } from "../core/errors.ts";
import { type Described, type DescribedColumn, DescribeError, type Describer } from "./describer.ts";

type Backend = {
  name: string;
  dataTypeIDs?: number[];
  fields?: { name: string; dataTypeID: number; tableID: number; columnID: number }[];
};

export async function openPgliteDescriber(ddl: string[]): Promise<Describer> {
  let mod: typeof import("@electric-sql/pglite");
  try {
    mod = await import("@electric-sql/pglite");
  } catch (e) {
    throw new TysqlError(
      "describer/pglite-missing",
      "tysql types .sql files with an embedded PGlite by default: npm install -D @electric-sql/pglite",
      { cause: e },
    );
  }
  const db: PGlite = new mod.PGlite();
  await db.waitReady;
  for (const sql of ddl) await db.exec(sql);
  return new PgliteDescriber(db);
}

export class PgliteDescriber implements Describer {
  readonly #db: PGlite;
  /** execProtocol の応答が混ざらないよう、呼び出しを直列にする */
  #turn: Promise<unknown> = Promise.resolve();
  constructor(db: PGlite) {
    this.#db = db;
  }

  #serial<T>(call: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(call, call);
    this.#turn = next.catch(() => {});
    return next;
  }

  describe(sql: string): Promise<Described> {
    return this.#serial(() => this.#describe(sql));
  }

  async #describe(sql: string): Promise<Described> {
    const message = concat(parseMessage(sql), describeMessage(), syncMessage());
    let messages: Backend[];
    try {
      ({ messages } = (await this.#db.execProtocol(message)) as { messages: Backend[] });
    } catch (e) {
      const err = e as { message: string; code?: string; position?: string; hint?: string };
      throw new DescribeError(err.message, {
        code: err.code ?? null,
        position: err.position === undefined ? null : Number(err.position),
        hint: err.hint ?? null,
        cause: e,
      });
    }
    const out: Described = { params: [], columns: null };
    for (const m of messages) {
      if (m.name === "parameterDescription") out.params = m.dataTypeIDs ?? [];
      else if (m.name === "rowDescription") {
        out.columns = (m.fields ?? []).map(
          (f): DescribedColumn => ({ name: f.name, oid: f.dataTypeID, table: f.tableID, attnum: f.columnID }),
        );
      }
    }
    return out;
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#serial(async () => (await this.#db.query<T>(sql, params)).rows);
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}

const encoder = new TextEncoder();

function frame(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, body.length + 4);
  out.set(body, 5);
  return out;
}

function cstring(s: string): Uint8Array {
  const bytes = encoder.encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

/** Parse: 無名ステートメント、パラメータ型は指定しない */
function parseMessage(sql: string): Uint8Array {
  return frame("P", concat(cstring(""), cstring(sql), new Uint8Array([0, 0])));
}

/** Describe: 無名ステートメント */
function describeMessage(): Uint8Array {
  return frame("D", concat(new Uint8Array([0x53]), cstring("")));
}

function syncMessage(): Uint8Array {
  return frame("S", new Uint8Array(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
