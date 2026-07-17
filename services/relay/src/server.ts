import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createRelayApp, LIMITS } from "@openclaw/reef-relay-core";
import { WebSocketServer } from "ws";
import { FileAssets } from "./assets.js";
import { resolveClientIp } from "./client-ip.js";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";
import { createEmailSender } from "./email.js";
import { applyMigrations } from "./migrations.js";
import { PostgresMailboxes } from "./postgres-mailboxes.js";
import { PostgresRelayStore } from "./postgres-store.js";

const config = loadConfig();
const log = (record: Record<string, unknown>) => console.log(JSON.stringify(record));
const pool = createPool(config.databaseUrl);
await applyMigrations(pool);
const mailboxes = new PostgresMailboxes(pool, log);
await mailboxes.start();
const app = createRelayApp({
  store: new PostgresRelayStore(pool),
  mailboxes,
  email: createEmailSender(config, log),
  assets: new FileAssets(config.staticDirectory),
  config: {
    publicOrigin: config.publicOrigin,
    emailFrom: config.emailFrom,
    developmentMode: config.developmentMode,
    canonicalSiteHost: config.canonicalSiteHost,
    redirectHosts: config.redirectHosts,
  },
  clientIp: (request) => request.headers.get("x-reef-client-ip") ?? "unknown",
  log,
});

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", config.publicOrigin).pathname;
    if (pathname === "/livez") return sendText(response, mailboxes.isReady() ? 200 : 500, mailboxes.isReady() ? "ok" : "not live");
    if (pathname === "/readyz") {
      if (!mailboxes.isReady()) return sendText(response, 503, "not ready");
      await pool.query("SELECT 1");
      return sendText(response, 200, "ok");
    }
    await writeResponse(response, await app.fetch(toWebRequest(request)));
  } catch (error) {
    log({ event: "node_request_error", error: error instanceof Error ? error.message : String(error) });
    sendText(response, 500, "internal error");
  }
});
let shuttingDown = false;

const webSockets = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes });
server.on("upgrade", async (request, socket, head) => {
  try {
    const authentication = await app.authenticateWebSocket(toWebRequest(request));
    if (authentication instanceof Response) {
      await rejectUpgrade(socket, authentication);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      void mailboxes.attach(authentication.handle, webSocket).catch((error) => {
        log({ event: "websocket_attach_error", error: error instanceof Error ? error.message : String(error) });
        webSocket.close(1011, "connection failed");
      });
    });
  } catch {
    socket.destroy();
  }
});

server.listen(config.port, "0.0.0.0", () => log({ event: "relay_listening", port: config.port }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: "relay_shutdown", signal });
  server.close();
  webSockets.close();
  await mailboxes.close();
  await pool.end();
  process.exit(0);
}

function toWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  headers.delete("x-reef-client-ip");
  headers.set("x-reef-client-ip", resolveClientIp(
    request.socket.remoteAddress,
    headers.get("x-forwarded-for"),
    config.trustedProxies,
  ));
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = new ReadableStream({
      start(controller) {
        request.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        request.on("end", () => controller.close());
        request.on("error", (error) => controller.error(error));
      },
      cancel() {
        request.destroy();
      },
    });
    init.duplex = "half";
  }
  return new Request(new URL(request.url ?? "/", config.publicOrigin), init);
}

async function writeResponse(target: ServerResponse, source: Response): Promise<void> {
  target.writeHead(source.status, Object.fromEntries(source.headers));
  if (!source.body) {
    target.end();
    return;
  }
  const reader = source.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!target.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => target.once("drain", resolve));
  }
  target.end();
}

async function rejectUpgrade(socket: Duplex, response: Response): Promise<void> {
  const body = await response.text();
  socket.end(
    `HTTP/1.1 ${response.status} ${response.statusText || "Rejected"}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}
