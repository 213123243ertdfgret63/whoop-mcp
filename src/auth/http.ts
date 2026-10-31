import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small web-standard HTTP server on node:http: handlers take a Request and return a Response, as they did on
 * Bun.serve. Only what the setup page and the OAuth callback need.
 */

export type Handler = (req: Request) => Response | Promise<Response>;

export interface LocalServer {
  port: number;
  /** Stops listening. Graceful by default, so a response being written still goes out; `force` drops it. */
  stop(force?: boolean): void;
}

/** The message a body over `maxRequestBodySize` fails with, as Bun.serve's did; handlers map it to a 413. */
export const BODY_TOO_LARGE = "Request body exceeds maxRequestBodySize";

const NO_BODY = new Set(["GET", "HEAD"]);

/** A Request whose body streams from `msg` and errors once it passes `max` bytes. */
function toRequest(msg: IncomingMessage, hostname: string, port: number, max: number): Request {
  const host = msg.headers.host ?? `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(msg.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = msg.method ?? "GET";
  if (NO_BODY.has(method)) return new Request(`http://${host}${msg.url ?? "/"}`, { method, headers });
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      msg.on("data", (chunk: Buffer) => {
        if (received > max) return; // already failed; the rest is read and dropped, so the 413 still goes out
        received += chunk.length;
        if (received > max) controller.error(new Error(BODY_TOO_LARGE));
        else controller.enqueue(new Uint8Array(chunk));
      });
      msg.on("end", () => {
        if (received <= max) controller.close();
      });
      msg.on("error", (err) => controller.error(err));
    },
  });
  return new Request(`http://${host}${msg.url ?? "/"}`, { method, headers, body, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  const body = Buffer.from(await response.arrayBuffer());
  headers["content-length"] = String(body.length);
  res.writeHead(response.status, response.statusText || undefined, headers);
  res.end(body);
}

/** Listens on exactly `hostname:port` (no other address); rejects with the listen error, e.g. EADDRINUSE. */
export function serveLocal(opts: {
  hostname: string;
  port: number;
  fetch: Handler;
  maxRequestBodySize?: number;
}): Promise<LocalServer> {
  const max = opts.maxRequestBodySize ?? 1024 * 1024;
  let port = opts.port;
  const server: Server = createServer((msg, res) => {
    void (async () => {
      let response: Response;
      try {
        response = await opts.fetch(toRequest(msg, opts.hostname, port, max));
      } catch {
        response = new Response("Internal error", { status: 500 });
      }
      await send(res, response);
    })().catch(() => res.destroy());
  });
  // A keep-alive socket must not hold the port (or the process) after stop().
  server.keepAliveTimeout = 2_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // exclusive: a port shared with another process in the cluster sense would defeat the half-bound check.
    server.listen({ host: opts.hostname, port: opts.port, exclusive: true }, () => {
      server.off("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop(force = false) {
          server.close();
          if (force) server.closeAllConnections();
          else server.closeIdleConnections();
        },
      });
    });
  });
}

/** Whether this machine has an IPv6 loopback at all (if not, "localhost" can only mean 127.0.0.1). */
export async function hasIpv6Loopback(): Promise<boolean> {
  try {
    const probe = await serveLocal({ hostname: "::1", port: 0, fetch: () => new Response() });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}
