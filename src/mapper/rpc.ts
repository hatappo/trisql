/**
 * tsc が content mapper と話す JSON-RPC 2.0（stdio、LSP 風の Content-Length フレーミング）。
 */
export type Handler = (params: unknown) => unknown | Promise<unknown>;

export function serve(
  handlers: Record<string, Handler>,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process,
): void {
  let buffer = Buffer.alloc(0);
  // tsc は用が済むとパイプを閉じる。開いたままの DB で待ち続けないよう終了する
  io.stdin.on("end", () => process.exit(0));
  io.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`Bad header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      void dispatch(JSON.parse(body) as Message);
    }
  });

  type Message = { id?: number | string; method: string; params?: unknown };
  async function dispatch(message: Message): Promise<void> {
    const handler = handlers[message.method];
    let response: Record<string, unknown>;
    try {
      if (!handler) throw new Error(`Unknown method ${message.method}`);
      const result = await handler(message.params);
      response = { jsonrpc: "2.0", id: message.id, result: result ?? {} };
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? (error.stack ?? error.message) : String(error) },
      };
    }
    if (message.id === undefined) return;
    const payload = Buffer.from(JSON.stringify(response), "utf8");
    io.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    io.stdout.write(payload);
  }
}
