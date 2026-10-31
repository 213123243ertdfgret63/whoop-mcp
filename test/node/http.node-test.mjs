// The loopback server (src/auth/http.ts) on real Node, the runtime Claude Desktop runs the extension on.
// `bun test` runs the rest of the suite on Bun's own node:http, which differs in the details this server relies on
// (exclusive binds, closeIdleConnections, keep-alive, request body errors). Run with:  node --test test/node/
// The modules are bundled for Node first, the way the shipped server/index.mjs is (needs bun on PATH).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "whoop-node-test-"));
after(() => rmSync(out, { recursive: true, force: true }));
const entry = join(out, "entry.ts");
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(root, "src/auth/http.ts"))};\nexport { listenLocal, PortInUseError } from ${JSON.stringify(join(root, "src/auth/login.ts"))};\n`,
);
execFileSync("bun", ["build", entry, "--target=node", "--format=esm", "--outfile", join(out, "auth.mjs")], {
  stdio: "ignore",
});
const { BODY_TOO_LARGE, hasIpv6Loopback, serveLocal, listenLocal, PortInUseError } = await import(
  pathToFileURL(join(out, "auth.mjs")).href
);

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const get = (host, port, path = "/", headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host, port, path, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

const canListen = (host, port) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)));
  });

describe("serveLocal on Node", () => {
  test("hands the handler a web Request and writes its Response, cookies included", async () => {
    const server = await serveLocal({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        const headers = new Headers({ "x-path": url.pathname + url.search, "x-host": req.headers.get("host") ?? "" });
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return new Response("hi", { status: 201, headers });
      },
    });
    try {
      const r = await get("127.0.0.1", server.port, "/setup?t=abc");
      assert.equal(r.status, 201);
      assert.equal(r.body, "hi");
      assert.equal(r.headers["x-path"], "/setup?t=abc");
      assert.equal(r.headers["x-host"], `127.0.0.1:${server.port}`);
      assert.deepEqual(r.headers["set-cookie"], ["a=1", "b=2"]);
    } finally {
      server.stop(true);
    }
  });

  test("a body over the limit fails the handler's read, which can answer 413", async () => {
    let seen;
    const server = await serveLocal({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 1024,
      fetch: async (req) => {
        try {
          return new Response(`got ${(await req.text()).length}`);
        } catch (err) {
          seen = err.message;
          return new Response("Too large", { status: 413 });
        }
      },
    });
    try {
      const post = (size) =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: server.port,
              method: "POST",
              agent: false,
              headers: { "content-type": "application/json" },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8").on("data", (d) => {
                body += d;
              });
              res.on("end", () => resolve({ status: res.statusCode, body }));
            },
          );
          req.on("error", reject);
          req.end("x".repeat(size));
        });
      assert.deepEqual(await post(1024), { status: 200, body: "got 1024" });
      assert.equal((await post(64 * 1024)).status, 413);
      assert.equal(seen, BODY_TOO_LARGE);
    } finally {
      server.stop(true);
    }
  });

  test("a handler that throws gets a 500, and the server keeps serving", async () => {
    let calls = 0;
    const server = await serveLocal({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return new Response("ok");
      },
    });
    try {
      assert.equal((await get("127.0.0.1", server.port)).status, 500);
      assert.equal((await get("127.0.0.1", server.port)).body, "ok");
    } finally {
      server.stop(true);
    }
  });

  test("stop() frees the port, gracefully or forced", async () => {
    for (const force of [false, true]) {
      const server = await serveLocal({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      await get("127.0.0.1", server.port);
      server.stop(force);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await canListen("127.0.0.1", server.port), true, `force=${force}`);
    }
  });
});

describe("listenLocal on Node", () => {
  test("localhost gets both loopbacks, so nothing can front half the port", async () => {
    const port = await freePort();
    const server = await listenLocal(new URL(`http://localhost:${port}/callback`), () => new Response("mine"));
    try {
      assert.equal((await get("127.0.0.1", port)).body, "mine");
      if (await hasIpv6Loopback()) assert.equal((await get("::1", port)).body, "mine");
    } finally {
      server.stop();
    }
  });

  test("refuses when another program holds one loopback, and releases the other", async (t) => {
    if (!(await hasIpv6Loopback())) return t.skip("no IPv6 loopback");
    const port = await freePort();
    const squatter = createServer();
    await new Promise((r) => squatter.listen({ host: "::1", port, exclusive: true }, r));
    try {
      await assert.rejects(
        listenLocal(new URL(`http://localhost:${port}/callback`), () => new Response()),
        PortInUseError,
      );
      assert.equal(await canListen("127.0.0.1", port), true);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });

  test("refuses a port already taken on 127.0.0.1", async () => {
    const port = await freePort();
    const squatter = createServer();
    await new Promise((r) => squatter.listen({ host: "127.0.0.1", port, exclusive: true }, r));
    try {
      await assert.rejects(
        listenLocal(new URL(`http://127.0.0.1:${port}/cb`), () => new Response()),
        PortInUseError,
      );
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});
