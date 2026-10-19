import { mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";

import {
  HeadInjector,
  parseUiTarget,
  rewriteLocation,
  rewriteSetCookie,
  startUiProxy,
} from "./proxy.js";

const TAG = "<script data-test-bridge></script>";
const TOKEN = "tok-123";
const DESK_PORT = 41999;

// Feed `html` to a fresh injector split at `at` (whole when undefined), returning the output.
function inject(html: string, at?: number): string {
  const inj = new HeadInjector(TAG);
  if (at === undefined) return inj.write(html) + inj.end();
  return inj.write(html.slice(0, at)) + inj.write(html.slice(at)) + inj.end();
}

// Assert the injector's output for every possible two-chunk split, not just the whole string.
function assertInjects(html: string, expected: string) {
  assert.equal(inject(html), expected, "whole");
  for (let i = 1; i < html.length; i++) assert.equal(inject(html, i), expected, `split at ${i}`);
}

test("HeadInjector inserts right after <head>, wherever the chunks split", () => {
  const html = `<!doctype html><html lang="en"><head><title>x</title></head><body>hi</body></html>`;
  assertInjects(html, html.replace("<head>", `<head>${TAG}`));
});

test("HeadInjector skips a commented-out <head> and honors quoted '>' in attributes", () => {
  const html = `<!DOCTYPE html><!-- <head> --><!--[if IE]><head><![endif]--><html><HEAD data-x="a>b"><title>t</title></HEAD></html>`;
  assertInjects(html, html.replace(`<HEAD data-x="a>b">`, `<HEAD data-x="a>b">${TAG}`));
});

test("HeadInjector never mistakes <header> for <head>", () => {
  const html = `<html><body><header>h</header></body></html>`;
  assertInjects(html, html.replace("<html>", `<html>${TAG}`));
});

test("HeadInjector fallbacks: after <html>, else after the doctype, else prepended", () => {
  assertInjects(
    `<!doctype html><html><body>x</body></html>`,
    `<!doctype html><html>${TAG}<body>x</body></html>`,
  );
  // Never before the doctype — that would drop the page into quirks mode.
  assertInjects(`<!doctype html><body>x</body>`, `<!doctype html>${TAG}<body>x</body>`);
  assertInjects(`<p>fragment</p>`, `${TAG}<p>fragment</p>`);
});

test("HeadInjector passes bytes through untouched once it has injected", () => {
  const inj = new HeadInjector(TAG);
  assert.equal(inj.write("<html><head>"), `<html><head>${TAG}`);
  assert.equal(inj.write("<head>again"), "<head>again");
  assert.equal(inj.end(), "");
});

test("parseUiTarget accepts loopback http URLs and refuses everything else", () => {
  const ok = (input: string, url: string) =>
    assert.deepEqual(parseUiTarget(input), { ok: true, url });
  ok(
    "http://localhost:3000/api/dev-auth/sign-in?as=x",
    "http://localhost:3000/api/dev-auth/sign-in?as=x",
  );
  ok("localhost:3000", "http://localhost:3000/");
  ok("http://127.0.0.5:8080", "http://127.0.0.5:8080/");
  ok("http://127.1:8080", "http://127.0.0.1:8080/");
  ok("http://[::1]:5173/", "http://[::1]:5173/");
  ok("http://LOCALHOST:3000", "http://localhost:3000/");
  for (const bad of [
    "http://example.com:3000",
    "http://10.0.0.1:3000",
    "http://0.0.0.0:3000",
    "http://localhost.evil.com:3000",
    "http://127.0.0.1.nip.io:3000",
    "http://[::ffff:127.0.0.1]:3000",
    "https://localhost:3000",
    "ftp://localhost/",
    "",
  ]) {
    const parsed = parseUiTarget(bad);
    assert.equal(parsed.ok, false, `${bad} is refused`);
  }
  const remote = parseUiTarget("http://example.com:3000");
  assert.ok(!remote.ok && /not a loopback host/.test(remote.reason), "names the loopback rule");
  const https = parseUiTarget("https://localhost:3000");
  assert.ok(!https.ok && /http:\/\//.test(https.reason), "names the http-only rule");
});

test("rewriteLocation maps any loopback alias of the dev server onto the proxy origin", () => {
  const up = new URL("http://localhost:3000/");
  const proxy = "http://127.0.0.1:45000";
  assert.equal(rewriteLocation("http://localhost:3000/app?x=1#h", up, proxy), `${proxy}/app?x=1#h`);
  assert.equal(rewriteLocation("http://127.0.0.1:3000/app", up, proxy), `${proxy}/app`);
  assert.equal(rewriteLocation("//localhost:3000/app", up, proxy), `${proxy}/app`);
  assert.equal(rewriteLocation("/app", up, proxy), "/app", "relative stays relative");
  assert.equal(rewriteLocation("http://localhost:4000/x", up, proxy), "http://localhost:4000/x");
  assert.equal(rewriteLocation("https://example.com/", up, proxy), "https://example.com/");
});

test("rewriteSetCookie drops Domain; Secure (and SameSite=None) only when asked", () => {
  const cookie = "sid=abc; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None; Partitioned";
  assert.equal(
    rewriteSetCookie(cookie, false),
    "sid=abc; Path=/; Secure; HttpOnly; SameSite=None; Partitioned",
  );
  // Without Secure, SameSite=None would make the browser reject the cookie outright. Lax still works
  // in the iframe: the proxy (devbox:B) and the desk tab (devbox:A) are same-site — the port is not
  // part of the site — so Lax cookies ride the iframe's navigations and subresource requests.
  assert.equal(rewriteSetCookie(cookie, true), "sid=abc; Path=/; HttpOnly; SameSite=Lax");
  assert.equal(rewriteSetCookie("a=1; SameSite=Strict; Secure", true), "a=1; SameSite=Strict");
});

// ── Real sockets: a throwaway upstream behind the proxy ─────────────────────────────────────────

type Upstream = { port: number; url: string; hits: http.IncomingMessage[]; server: http.Server };

async function startUpstream(handler: http.RequestListener): Promise<Upstream> {
  const hits: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, url: `http://localhost:${port}`, hits, server };
}

async function withProxy(
  target: string | undefined,
  run: (port: number) => Promise<void>,
  allowedHosts: string[] = ["127.0.0.1", "localhost", "[::1]"],
) {
  const proxy = await startUiProxy({
    host: "127.0.0.1",
    port: 0,
    allowedHosts,
    deskPort: DESK_PORT,
    token: TOKEN,
    target: () => target,
    bridgeJs: async () => "/* bridge */",
  });
  try {
    await run(proxy.port);
  } finally {
    proxy.close();
  }
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

// http.request (not fetch) so the test controls Host and the Fetch-Metadata headers exactly.
function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, accept: "text/html", ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const PAGE = `<!doctype html><html><head><title>App</title></head><body>héllo ✓</body></html>`;
const bridgeTag = (deskHost = "127.0.0.1") =>
  `<script src="/__galley/bridge.js" data-galley-desk="http://${deskHost}:${DESK_PORT}" data-galley-token="${TOKEN}"></script>`;

test("proxy injects the bridge tag after <head> of an HTML page, preserving UTF-8", async () => {
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=3600",
      etag: '"v1"',
    });
    res.end(PAGE);
  });
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const res = await request(port, "/app?x=1");
      assert.equal(res.status, 200);
      assert.equal(res.body, PAGE.replace("<head>", `<head>${bridgeTag()}`));
      // The page embeds this desk process's token: never let the browser reuse a cached copy.
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers.etag, undefined);
      assert.equal(up.hits[0]!.url, "/app?x=1", "path + query forwarded as-is");
      assert.equal(up.hits[0]!.headers.host, `localhost:${up.port}`, "Host rewritten to upstream");
    });
  } finally {
    up.server.close();
  }
});

test("proxy injects into a <head> split across upstream chunks", async () => {
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><!-- <head> --><html><he");
    setTimeout(() => res.end("ad><title>x</title></head><body></body></html>"), 30);
  });
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const res = await request(port, "/");
      assert.equal(
        res.body,
        `<!doctype html><!-- <head> --><html><head>${bridgeTag()}<title>x</title></head><body></body></html>`,
      );
    });
  } finally {
    up.server.close();
  }
});

test("proxy decompresses a gzipped HTML page to inject; other bodies stay encoded", async () => {
  const up = await startUpstream((req, res) => {
    const js = req.url === "/app.js";
    res.writeHead(200, {
      "content-type": js ? "text/javascript" : "text/html",
      "content-encoding": "gzip",
    });
    res.end(zlib.gzipSync(js ? "console.log(1)" : PAGE));
  });
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const page = await request(port, "/", { "accept-encoding": "gzip, zstd" });
      assert.equal(page.headers["content-encoding"], undefined);
      assert.equal(page.body, PAGE.replace("<head>", `<head>${bridgeTag()}`));
      assert.equal(up.hits[0]!.headers["accept-encoding"], "gzip", "narrowed to decodable codings");
      const js = await new Promise<Buffer>((resolve) =>
        http.get(
          {
            port,
            path: "/app.js",
            headers: { host: `127.0.0.1:${port}`, "accept-encoding": "gzip" },
          },
          (res) => {
            assert.equal(
              res.headers["content-encoding"],
              "gzip",
              "non-HTML passes through encoded",
            );
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        ),
      );
      assert.equal(zlib.gunzipSync(js).toString(), "console.log(1)");
    });
  } finally {
    up.server.close();
  }
});

test("proxy never injects into an HTML fragment fetched by the app", async () => {
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<div>partial</div>");
  });
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const res = await request(port, "/partial", { "sec-fetch-dest": "empty" });
      assert.equal(res.body, "<div>partial</div>");
      const doc = await request(port, "/page", { "sec-fetch-dest": "iframe" });
      assert.ok(
        doc.body.includes("/__galley/bridge.js"),
        "a framed document still gets the bridge",
      );
    });
  } finally {
    up.server.close();
  }
});

test("proxy replaces framing headers on HTML only", async () => {
  const framing = {
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'; script-src 'self'",
    "content-security-policy-report-only": "default-src 'self'",
  };
  const up = await startUpstream((req, res) => {
    const html = req.url === "/";
    res.writeHead(200, { "content-type": html ? "text/html" : "application/json", ...framing });
    res.end(html ? PAGE : "{}");
  });
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const page = await request(port, "/");
      assert.equal(page.headers["x-frame-options"], undefined);
      assert.equal(page.headers["content-security-policy-report-only"], undefined);
      assert.equal(
        page.headers["content-security-policy"],
        `frame-ancestors http://127.0.0.1:${DESK_PORT}`,
        "only the desk origin may frame the app",
      );
      const api = await request(port, "/api", { accept: "application/json" });
      assert.equal(api.headers["x-frame-options"], "DENY", "non-HTML keeps its headers");
      assert.equal(api.headers["content-security-policy"], framing["content-security-policy"]);
    });
  } finally {
    up.server.close();
  }
});

test("proxy rewrites redirects and cookies; the desk origin follows the request's hostname", async () => {
  const up = await startUpstream((req, res) => {
    if (req.url === "/sign-in")
      res.writeHead(302, {
        location: `http://localhost:${up.port}/app?welcome=1`,
        "set-cookie": [
          "session=s1; Domain=localhost; Path=/; HttpOnly; Secure; SameSite=None",
          "theme=dark; Path=/",
        ],
      });
    else res.writeHead(302, { location: "/relative" });
    res.end();
  });
  try {
    await withProxy(
      `${up.url}/sign-in`,
      async (port) => {
        const local = await request(port, "/sign-in");
        assert.equal(local.status, 302);
        assert.equal(local.headers.location, `http://127.0.0.1:${port}/app?welcome=1`);
        assert.deepEqual(local.headers["set-cookie"], [
          "session=s1; Path=/; HttpOnly; Secure; SameSite=None",
          "theme=dark; Path=/",
        ]);
        // Reached as the devbox over plain http: Secure is dropped (SameSite=None with it).
        const remote = await request(port, "/sign-in", { host: `devbox:${port}` });
        assert.equal(remote.headers.location, `http://devbox:${port}/app?welcome=1`);
        assert.deepEqual(remote.headers["set-cookie"], [
          "session=s1; Path=/; HttpOnly; SameSite=Lax",
          "theme=dark; Path=/",
        ]);
        const relative = await request(port, "/other");
        assert.equal(relative.headers.location, "/relative");
      },
      ["127.0.0.1", "localhost", "[::1]", "devbox"],
    );
  } finally {
    up.server.close();
  }
});

test("proxy rewrites Origin and Referer to the dev server's own origin", async () => {
  const up = await startUpstream((_req, res) => res.end("ok"));
  try {
    await withProxy(`${up.url}/`, async (port) => {
      await request(
        port,
        "/api/auth",
        {
          origin: `http://127.0.0.1:${port}`,
          referer: `http://127.0.0.1:${port}/app?x=1`,
          accept: "application/json",
        },
        "POST",
      );
      assert.equal(up.hits[0]!.headers.origin, up.url);
      assert.equal(up.hits[0]!.headers.referer, `${up.url}/app?x=1`);
    });
  } finally {
    up.server.close();
  }
});

test("proxy refuses a cross-site mutating request before the dev server's origin check can be fooled", async () => {
  const up = await startUpstream((_req, res) => res.end("ok"));
  try {
    await withProxy(`${up.url}/`, async (port) => {
      // Rewriting a foreign Origin to the dev server's own would turn a cross-site POST into a
      // same-origin one in the app's eyes (its CSRF/origin checks). Only the proxied app may mutate.
      for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${DESK_PORT}`]) {
        const res = await request(port, "/api/delete", { origin }, "POST");
        assert.equal(res.status, 403, origin);
      }
      assert.equal(up.hits.length, 0, "the upstream was never contacted");
      // A cross-site GET still passes, with its real Origin, so the app's CORS logic decides.
      await request(port, "/api/public", { origin: "http://evil.example" });
      assert.equal(
        up.hits[0]!.headers.origin,
        "http://evil.example",
        "a foreign Origin isn't laundered",
      );
      // No Origin at all (a plain navigation, curl) passes as before.
      const bare = await request(port, "/api/delete", {}, "POST");
      assert.equal(bare.status, 200);
    });
  } finally {
    up.server.close();
  }
});

test("proxy rejects a foreign Host with 403 before contacting the dev server", async () => {
  const up = await startUpstream((_req, res) => res.end(PAGE));
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const res = await request(port, "/", { host: `evil.example:${port}` });
      assert.equal(res.status, 403);
      const rebound = await request(port, "/", { host: `127.0.0.1:${port + 1}` });
      assert.equal(rebound.status, 403, "the authority must carry the proxy's own port");
      assert.equal(up.hits.length, 0, "the upstream was never contacted");
    });
  } finally {
    up.server.close();
  }
});

test("proxy refuses a non-loopback upstream without dialing it", async () => {
  await withProxy("http://192.0.2.10:3000/", async (port) => {
    const res = await request(port, "/");
    assert.equal(res.status, 502);
    assert.match(res.body, /not a loopback host/);
  });
});

test("proxy serves the bridge from its reserved prefix and never forwards that prefix", async () => {
  const up = await startUpstream((_req, res) => res.end("upstream"));
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const bridge = await request(port, "/__galley/bridge.js");
      assert.equal(bridge.status, 200);
      assert.match(String(bridge.headers["content-type"]), /javascript/);
      assert.equal(bridge.body, "/* bridge */");
      const other = await request(port, "/__galley/anything");
      assert.equal(other.status, 404);
      assert.equal(up.hits.length, 0);
    });
  } finally {
    up.server.close();
  }
});

// A dead port: bind, read the port, close — nothing listens there afterwards.
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

test("proxy answers a document navigation with the waiting page while the dev server is down", async () => {
  const port = await deadPort();
  await withProxy(`http://localhost:${port}/app`, async (proxyPort) => {
    const page = await request(proxyPort, "/app", { "sec-fetch-dest": "iframe" });
    assert.equal(page.status, 502);
    assert.match(page.body, /Waiting for the dev server at <code>http:\/\/localhost:\d+<\/code>/);
    assert.match(page.body, /retrying every 2 s/);
    assert.match(page.body, /__galley\/health/, "the page polls the health probe");
    assert.equal(
      page.headers["content-security-policy"],
      `frame-ancestors http://127.0.0.1:${DESK_PORT}`,
    );
    const xhr = await request(proxyPort, "/api/x", {
      accept: "application/json",
      "sec-fetch-dest": "empty",
    });
    assert.equal(xhr.status, 502);
    assert.doesNotMatch(xhr.body, /Waiting for the dev server/, "XHR/assets get a plain 502");
    const health = await request(proxyPort, "/__galley/health");
    assert.equal(health.status, 200, "never a console-noisy error status");
    assert.deepEqual(JSON.parse(health.body), { up: false });
  });
});

test("the health probe reports up once the dev server answers", async () => {
  const up = await startUpstream((_req, res) => res.end("ok"));
  try {
    await withProxy(`${up.url}/`, async (port) => {
      assert.deepEqual(JSON.parse((await request(port, "/__galley/health")).body), { up: true });
    });
  } finally {
    up.server.close();
  }
});

// Raw websocket handshake through the proxy: resolves with the response head and the socket.
function handshake(
  port: number,
  headers: Record<string, string>,
): Promise<{ head: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [
        "GET /_ws HTTP/1.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ head: buf.slice(0, end), socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

async function startWsUpstream() {
  const seen: http.IncomingHttpHeaders[] = [];
  const up = await startUpstream((_req, res) => res.end());
  up.server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    seen.push(req.headers);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (d) => socket.write(d)); // echo raw frames
  });
  return { ...up, seen };
}

test("proxy passes a websocket upgrade through, rewriting Host and Origin", async () => {
  const up = await startWsUpstream();
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const { head, socket } = await handshake(port, {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      });
      assert.match(head, /^HTTP\/1\.1 101/);
      assert.equal(up.seen[0]!.host, `localhost:${up.port}`);
      assert.equal(up.seen[0]!.origin, up.url);
      const echoed = await new Promise<string>((resolve) => {
        socket.once("data", (d) => resolve(d.toString()));
        socket.write("live-reload ping");
      });
      assert.equal(echoed, "live-reload ping", "bytes flow both ways after the upgrade");
      socket.destroy();
    });
  } finally {
    up.server.close();
  }
});

test("proxy refuses a websocket upgrade from a foreign Origin or Host", async () => {
  const up = await startWsUpstream();
  try {
    await withProxy(`${up.url}/`, async (port) => {
      const cross = await handshake(port, {
        Host: `127.0.0.1:${port}`,
        Origin: "http://evil.example",
      });
      assert.match(cross.head, /^HTTP\/1\.1 403/);
      cross.socket.destroy();
      // The desk's own origin isn't the app's: only the proxied page may open the socket.
      const desk = await handshake(port, {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${DESK_PORT}`,
      });
      assert.match(desk.head, /^HTTP\/1\.1 403/);
      desk.socket.destroy();
      const host = await handshake(port, {
        Host: `evil.example:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      });
      assert.match(host.head, /^HTTP\/1\.1 403/);
      host.socket.destroy();
      assert.equal(up.seen.length, 0, "the upstream never saw an upgrade");
    });
  } finally {
    up.server.close();
  }
});

test("startUiProxy takes the next free port when its preferred one is held", async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const address = holder.address();
  const held = typeof address === "object" && address ? address.port : 0;
  const proxy = await startUiProxy({
    host: "127.0.0.1",
    port: held,
    allowedHosts: ["127.0.0.1"],
    deskPort: DESK_PORT,
    token: TOKEN,
    target: () => undefined,
    bridgeJs: async () => null,
  });
  try {
    assert.ok(proxy.port > 0 && proxy.port !== held, "bound elsewhere");
  } finally {
    proxy.close();
    holder.close();
  }
});

// Hold `size` consecutive free loopback ports, starting at a random port above Galley's default
// range, so a GALLEY_PORT_RANGE test never assumes a fixed port is free. Release one to free it.
async function holdPortBlock(size: number) {
  const close = (s: net.Server) => new Promise<void>((resolve) => s.close(() => resolve()));
  for (let attempt = 0; attempt < 50; attempt++) {
    const lo = 52000 + Math.floor(Math.random() * 8000);
    const held = new Map<number, net.Server>();
    try {
      for (let port = lo; port < lo + size; port++) {
        const s = net.createServer();
        await new Promise<void>((resolve, reject) => {
          s.once("error", reject);
          s.listen(port, "127.0.0.1", resolve);
        });
        held.set(port, s);
      }
      const release = async (...ports: number[]) => {
        for (const port of ports) {
          const s = held.get(port);
          held.delete(port);
          if (s) await close(s);
        }
      };
      return { lo, hi: lo + size - 1, release, releaseAll: () => release(...held.keys()) };
    } catch {
      await Promise.all([...held.values()].map(close));
    }
  }
  throw new Error("no free block of loopback ports");
}

test("with a GALLEY_PORT_RANGE, startUiProxy's next-free walk wraps from hi to lo, never past hi", async () => {
  const block = await holdPortBlock(4);
  // Preferred hi-1 and hi stay held; lo is free.
  await block.release(block.lo, block.lo + 1);
  try {
    const proxy = await startUiProxy({
      host: "127.0.0.1",
      port: block.hi - 1,
      portRange: { lo: block.lo, hi: block.hi },
      allowedHosts: ["127.0.0.1"],
      deskPort: DESK_PORT,
      token: TOKEN,
      target: () => undefined,
      bridgeJs: async () => null,
    });
    try {
      assert.equal(proxy.port, block.lo);
    } finally {
      proxy.close();
    }
  } finally {
    await block.releaseAll();
  }
});

test("with every GALLEY_PORT_RANGE port held, startUiProxy warns once naming the range and binds a random port", async () => {
  const block = await holdPortBlock(2);
  const errors = mock.method(console, "error", () => {});
  try {
    const proxy = await startUiProxy({
      host: "127.0.0.1",
      port: block.lo,
      portRange: { lo: block.lo, hi: block.hi },
      allowedHosts: ["127.0.0.1"],
      deskPort: DESK_PORT,
      token: TOKEN,
      target: () => undefined,
      bridgeJs: async () => null,
    });
    try {
      assert.ok(proxy.port > 0 && (proxy.port < block.lo || proxy.port > block.hi));
      assert.deepEqual(
        errors.mock.calls.map((c) => String(c.arguments[0])),
        [
          `GALLEY_PORT_RANGE: every port in ${block.lo}-${block.hi} is taken — falling back to a random port for the app.`,
        ],
      );
    } finally {
      proxy.close();
    }
  } finally {
    errors.mock.restore();
    await block.releaseAll();
  }
});
