// Minimal TypeScript 7.1 content mapper: JSON-RPC 2.0 over stdio with Content-Length framing.
// Logs every request to mapper.log so the protocol can be inspected.
import { appendFileSync } from "node:fs";
const log = (s) => appendFileSync(new URL("./mapper.log", import.meta.url), s + "\n");

const handlers = {
  initialize(params) {
    log("initialize " + JSON.stringify(params));
    return { protocolVersion: params?.protocolVersion ?? 1, positionEncoding: "utf-8", diagnosticSource: "tysql" };
  },
  openProject(params) {
    log("openProject " + JSON.stringify(params));
    return {};
  },
  transform(params) {
    log("transform " + JSON.stringify({ ...params, content: params.content?.slice(0, 60) }));
    const sql = params.content;
    const m = /\/\*\$(\w+)\*\//.exec(sql);
    const name = m ? m[1] : "id";
    const text = [
      `export type Params = { ${name}: number };`,
      `export type Row = { id: number; email: string | null };`,
      `declare const query: { run(params: Params): Promise<Row[]>; raw: string };`,
      `export default query;`,
      ``,
    ].join("\n");
    const bytes = Buffer.byteLength(text);
    const sqlBytes = Buffer.byteLength(sql);
    const ATOM = 1, DEFINITION = 8;
    const diagnostics = [];
    if (sql.includes("BROKEN")) diagnostics.push({ messageText: "tysql: BROKEN found in SQL", start: sql.indexOf("BROKEN"), length: 6, code: 1 });
    return { extension: ".ts", text, mappings: [[0, bytes, 0, sqlBytes, ATOM, DEFINITION]], diagnostics };
  },
  closeProject(params) {
    log("closeProject " + JSON.stringify(params));
    return {};
  },
};

let buffer = Buffer.alloc(0);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
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
    dispatch(JSON.parse(body));
  }
});
async function dispatch(message) {
  const handler = handlers[message.method];
  let response;
  try {
    if (!handler) { log("UNKNOWN " + JSON.stringify(message)); throw new Error(`Unknown method ${message.method}`); }
    const result = await handler(message.params);
    response = { jsonrpc: "2.0", id: message.id, result: result ?? {} };
  } catch (error) {
    response = { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.stack ?? String(error) } };
  }
  if (message.id === undefined) return;
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}
