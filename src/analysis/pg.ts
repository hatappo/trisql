/**
 * 実 DB（接続 URL）による Describer。`pg`（node-postgres）で Parse / Describe を送る。
 * `pg` は公開の describe API を持たないが、`client.query` に "submittable" を渡せるので、
 * 自前で Parse + Describe + Sync を流して応答を拾う（pg-cursor と同じ仕組み）。
 */
import { TrisqlError } from "../core/errors.ts";
import { type Described, type DescribedColumn, DescribeError, type Describer } from "./describer.ts";

type Connection = {
  parse(options: { name: string; text: string; types: number[] }): void;
  describe(options: { type: "S" | "P"; name: string }): void;
  sync(): void;
  on(event: string, listener: (message: unknown) => void): void;
  off(event: string, listener: (message: unknown) => void): void;
};

type Submittable = {
  submit(connection: Connection): void;
  handleRowDescription(message: {
    fields: { name: string; dataTypeID: number; tableID: number; columnID: number }[];
  }): void;
  handleParseComplete(): void;
  handleDataRow(): void;
  handleCommandComplete(): void;
  handleEmptyQuery(): void;
  handlePortalSuspended(): void;
  handleError(error: Error): void;
  handleReadyForQuery(): void;
};

type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: "error", listener: (e: Error) => void): void;
  query(submittable: Submittable): unknown;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

const CONNECT_TIMEOUT_MS = 10_000;

export async function openPgDescriber(url: string): Promise<Describer> {
  let pg: { Client: new (options: { connectionString: string; connectionTimeoutMillis: number }) => PgClient };
  try {
    pg = (await import("pg")).default as unknown as typeof pg;
  } catch (e) {
    throw new TrisqlError("describer/pg-missing", `"databaseUrl" needs the pg driver: npm install pg`, { cause: e });
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // アイドル中の切断はイベントで通知される。聞いていないとプロセスが落ちる
  client.on("error", () => {});
  await client.connect();
  return new PgDescriber(client);
}

export class PgDescriber implements Describer {
  readonly #client: PgClient;
  #turn: Promise<unknown> = Promise.resolve();
  constructor(client: PgClient) {
    this.#client = client;
  }

  /** pg は同時に 1 クエリしか流せないので直列にする */
  #serial<T>(call: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(call, call);
    this.#turn = next.catch(() => {});
    return next;
  }

  describe(sql: string): Promise<Described> {
    return this.#serial(
      () =>
        new Promise<Described>((resolve, reject) => {
          const out: Described = { params: [], columns: null };
          let connection: Connection | undefined;
          const onParam = (m: unknown) => {
            out.params = (m as { dataTypeIDs: number[] }).dataTypeIDs;
          };
          const onNoData = () => {
            out.columns = null;
          };
          const cleanup = () => {
            connection?.off("parameterDescription", onParam);
            connection?.off("noData", onNoData);
          };
          const submittable: Submittable = {
            submit(c) {
              connection = c;
              // parameterDescription と noData は pg がクエリに回さないので、接続から直接拾う
              c.on("parameterDescription", onParam);
              c.on("noData", onNoData);
              c.parse({ name: "", text: sql, types: [] });
              c.describe({ type: "S", name: "" });
              c.sync();
            },
            handleRowDescription(m) {
              out.columns = m.fields.map(
                (f): DescribedColumn => ({ name: f.name, oid: f.dataTypeID, table: f.tableID, attnum: f.columnID }),
              );
            },
            handleParseComplete() {},
            handleDataRow() {},
            handleCommandComplete() {},
            handleEmptyQuery() {},
            handlePortalSuspended() {},
            handleError(error) {
              cleanup();
              const e = error as Error & { code?: string; position?: string; hint?: string };
              reject(
                new DescribeError(e.message, {
                  code: e.code ?? null,
                  position: e.position === undefined ? null : Number(e.position),
                  hint: e.hint ?? null,
                  cause: e,
                }),
              );
            },
            handleReadyForQuery() {
              cleanup();
              resolve(out);
            },
          };
          this.#client.query(submittable);
        }),
    );
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#serial(async () => (await this.#client.query(sql, params)).rows as T[]);
  }

  close(): Promise<void> {
    return this.#client.end();
  }
}
