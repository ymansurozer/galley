import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { pipeline, Transform } from "node:stream";
import zlib from "node:zlib";

// The UI proxy: a second listener per desk that reverse-proxies the agent's running dev server at
// the root of its own origin, so the desk's UI view can show the app in an iframe. A different
// port is a different origin — the app's JS can't call the desk API (the desk's origin guard
// rejects it) — while the same hostname keeps it same-site with the desk tab, so the app's
// SameSite=Lax session cookies work inside the iframe. Every HTML page gets the bridge script
// injected; the bridge talks to the desk tab only over tokenized postMessage.
//
// Hand-rolled on node:http/net (no proxy dependency): HTTP is piped through http.request,
// websockets through the `upgrade` event and raw socket piping.

// Reserved prefix on the proxy origin — served by Galley itself, never forwarded upstream.
export const RESERVED_PREFIX = "/__galley/";
const BRIDGE_PATH = `${RESERVED_PREFIX}bridge.js`;
const HEALTH_PATH = `${RESERVED_PREFIX}health`;

export type UiTargetParse = { ok: true; url: string } | { ok: false; reason: string };

// Loopback only (localhost, 127.0.0.0/8, ::1): the proxy must never become a hop to another host
// (SSRF). URL already normalizes IPv4 shorthands (127.1 → 127.0.0.1) and brackets IPv6.
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// Validate a UI target (`--ui <url>`, `galley ui <url>`, POST /api/ui, and again per proxied
// request). A bare `localhost:3000` gets http:// prefixed. Only plain http: the proxy speaks http
// to the dev server, so an https dev server is refused rather than half-supported.
export function parseUiTarget(input: string): UiTargetParse {
  const raw = input.trim();
  if (!raw)
    return { ok: false, reason: "a UI target URL is required (e.g. http://localhost:3000)" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL` };
  }
  if (url.protocol !== "http:")
    return {
      ok: false,
      reason: `"${raw}" must be an http:// URL — Galley proxies plain-http dev servers only`,
    };
  if (!isLoopbackHostname(url.hostname))
    return {
      ok: false,
      reason: `"${url.hostname}" is not a loopback host — Galley only proxies a dev server on this machine (localhost, 127.0.0.0/8, ::1)`,
    };
  return { ok: true, url: url.href };
}

// Inserts the bridge tag right after the document's `<head …>` while the body streams through.
// Works on latin1 strings so it is byte-preserving for any ASCII-compatible encoding (UTF-8
// continuation bytes are ≥0x80 and never match a tag). Comment-aware: a `<head>` inside
// `<!-- … -->` (conditional comments, commented-out markup) is skipped. Output is held back only
// until the insertion point is known; past that, chunks pass straight through. Fallbacks when
// there's no `<head>` before `<body>` (or the end, or the hold-back cap): after `<html …>`, else
// after the doctype, else prepended.
export class HeadInjector {
  private buf = "";
  private scan = 0;
  private inComment = false;
  private fallbackAt = 0;
  private done = false;

  constructor(
    private readonly tag: string,
    private readonly holdLimit = 256 * 1024,
  ) {}

  write(chunk: string): string {
    if (this.done) return chunk;
    this.buf += chunk;
    const at = this.find();
    if (at !== null) return this.inject(at);
    return this.buf.length > this.holdLimit ? this.inject(this.fallbackAt) : "";
  }

  end(): string {
    return this.done ? "" : this.inject(this.fallbackAt);
  }

  private inject(at: number): string {
    const out = this.buf.slice(0, at) + this.tag + this.buf.slice(at);
    this.done = true;
    this.buf = "";
    return out;
  }

  // The insertion index, or null to wait for more input. Resumable: scan/inComment persist.
  private find(): number | null {
    const b = this.buf;
    while (this.scan < b.length) {
      if (this.inComment) {
        const close = b.indexOf("-->", this.scan);
        if (close < 0) {
          this.scan = Math.max(this.scan, b.length - 2); // "-->" may straddle the next chunk
          return null;
        }
        this.inComment = false;
        this.scan = close + 3;
        continue;
      }
      const lt = b.indexOf("<", this.scan);
      if (lt < 0) {
        this.scan = b.length;
        return null;
      }
      this.scan = lt;
      // `<head` + a delimiter is the longest prefix we must see before deciding.
      if (b.length - lt < 6) return null;
      const head = b.slice(lt, lt + 6).toLowerCase();
      if (head.startsWith("<!--")) {
        this.inComment = true;
        this.scan = lt + 4;
        continue;
      }
      if (head.startsWith("<!")) {
        const end = tagEnd(b, lt + 2);
        if (end < 0) return null;
        if (head.startsWith("<!doct")) this.fallbackAt = Math.max(this.fallbackAt, end);
        this.scan = end;
        continue;
      }
      const name = head.slice(1, 5);
      if ((name === "head" || name === "html" || name === "body") && /[\s/>]/.test(head[5]!)) {
        if (name === "body") return this.fallbackAt;
        const end = tagEnd(b, lt + 5);
        if (end < 0) return null;
        if (name === "head") return end;
        this.fallbackAt = end;
        this.scan = end;
        continue;
      }
      this.scan = lt + 1;
    }
    return null;
  }
}

// Index just past the `>` closing a tag whose name ends before `from`, honoring quoted attribute
// values; -1 when the tag isn't complete yet.
function tagEnd(s: string, from: number): number {
  let quote = "";
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return -1;
}

function injectStream(tag: string): Transform {
  const injector = new HeadInjector(tag);
  const emit = (s: string) => (s ? Buffer.from(s, "latin1") : undefined);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, emit(injector.write(chunk.toString("latin1"))));
    },
    flush(cb) {
      cb(null, emit(injector.end()));
    },
  });
}

// Set-Cookie through the proxy: Domain names the upstream host and would make the browser drop the
// cookie on the proxy origin, so it goes. Secure goes only on a non-loopback proxy host (the devbox
// over plain http) — browsers already accept Secure cookies on http://localhost, exactly as they
// would talking to the dev server directly. SameSite=None requires Secure, so it falls to Lax with
// it; Partitioned requires Secure too.
export function rewriteSetCookie(cookie: string, dropSecure: boolean): string {
  const [pair, ...attrs] = cookie.split(";");
  const out = [pair!.trim()];
  for (const raw of attrs) {
    const attr = raw.trim();
    const [name = "", value = ""] = attr.split("=").map((s) => s.trim().toLowerCase());
    if (name === "domain") continue;
    if (dropSecure && (name === "secure" || name === "partitioned")) continue;
    if (dropSecure && name === "samesite" && value === "none") {
      out.push("SameSite=Lax");
      continue;
    }
    if (attr) out.push(attr);
  }
  return out.join("; ");
}

// An absolute redirect back to the dev server (by any loopback alias, same port) lands on the
// proxy origin instead, so the app never escapes the iframe onto the raw dev-server origin.
// Relative and foreign redirects pass through untouched.
export function rewriteLocation(location: string, upstream: URL, proxyOrigin: string): string {
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return location;
  let url: URL;
  try {
    url = new URL(location, upstream);
  } catch {
    return location;
  }
  const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
  if (url.protocol !== upstream.protocol || port(url) !== port(upstream)) return location;
  if (!isLoopbackHostname(url.hostname)) return location;
  return `${proxyOrigin}${url.pathname}${url.search}${url.hash}`;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) are per connection, never forwarded.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// What a browser fetch is for: HTML injection and the waiting page apply to documents only, so an
// HTML fragment fetched by the app (htmx, partials) is never handed a bridge script. Without the
// Fetch-Metadata header (non-browser clients), fall back to the Accept header.
function isDocumentRequest(req: http.IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  if (typeof dest === "string") return dest === "document" || dest === "iframe" || dest === "frame";
  return /text\/html/i.test(String(req.headers.accept ?? ""));
}

function decoderFor(encoding: string | undefined): Transform | null | undefined {
  const e = (encoding ?? "").trim().toLowerCase();
  if (!e || e === "identity") return null;
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return undefined; // unknown — can't decode, so the body passes through uninjected
}

// The client's accept-encoding narrowed to what decoderFor can undo, so an HTML body is never in an
// encoding the injector can't read.
function narrowAcceptEncoding(value: string | string[] | undefined): string | undefined {
  const ok = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^(gzip|deflate|br)(;|$)/i.test(s));
  return ok.length ? ok.join(", ") : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Served into the iframe for a document navigation while the dev server refuses connections: it
// polls the health probe every 2 s and reloads the same URL once the upstream answers. Styled after
// the desk's waiting card (dark tokens, inlined — the page can't reach the desk's CSS).
export function waitingPage(target: string): string {
  const server = escapeHtml(new URL(target).origin);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Waiting for the dev server</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  html, body { height: 100%; margin: 0 }
  body { display: grid; place-items: center; padding: 20px; box-sizing: border-box; background: #070909;
    font: 12px/1.55 "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #d9d9d4 }
  .card { width: min(480px, 100%); box-sizing: border-box; padding: 18px 20px; border: 1px solid #222a2d;
    border-radius: 12px; background: #0b0e0f }
  h1 { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 8px; font-size: 14px; font-weight: 600 }
  code { color: #8fc4d4; font: 500 13px "JetBrains Mono", ui-monospace, monospace }
  p { margin: 0 0 6px; color: #8a9396 }
  .tries { color: #4b5558; font: 11px "JetBrains Mono", ui-monospace, monospace }
  .spin { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; border: 2px solid #354146;
    border-top-color: #00a8ff; animation: spin .8s linear infinite; flex: 0 0 auto }
  @keyframes spin { to { transform: rotate(360deg) } }
</style></head>
<body><div class="card">
  <h1><span class="spin"></span>Waiting for the dev server at <code>${server}</code></h1>
  <p>Galley keeps retrying and loads the app as soon as it answers. The agent starts and restarts the dev server — Galley never does.</p>
  <div class="tries" id="tries">attempt 1 · retrying every 2 s</div>
</div>
<script>
  let attempt = 1;
  const tries = document.getElementById("tries");
  async function probe() {
    try {
      const res = await fetch(${JSON.stringify(HEALTH_PATH)}, { cache: "no-store" });
      if ((await res.json()).up) return location.replace(location.href);
    } catch {}
    attempt++;
    tries.textContent = "attempt " + attempt + " · retrying every 2 s";
    setTimeout(probe, 2000);
  }
  setTimeout(probe, 2000);
</script></body></html>
`;
}

export type UiProxyOptions = {
  // Bind address — the desk's own (loopback by default, the GALLEY_HOST bind on the devbox).
  host: string;
  // Preferred port (stableUiPort); taken → the next ones, then a random port. 0 = random.
  port: number;
  // Host names the desk's origin guard trusts (resolveBinding); accepted here on the proxy port.
  allowedHosts: readonly string[];
  // The desk's port: the desk origin (frame-ancestors, the bridge's postMessage target) is the
  // request's own hostname on this port, so it follows whichever name the reviewer used.
  deskPort: number;
  token: string;
  // The current UI target, read per request — `galley ui` replaces it on a live desk.
  target: () => string | undefined;
  // The bridge bundle's source, or null when it isn't built.
  bridgeJs: () => Promise<string | null>;
};

export type UiProxy = { server: http.Server; port: number; close: () => void };

export async function startUiProxy(opts: UiProxyOptions): Promise<UiProxy> {
  let port = 0;
  const upgraded = new Set<Duplex>();

  // The Host guard (the same DNS-rebinding defense as the desk's originAllowed): the host name the
  // request was addressed to, or null when it isn't one of the desk's own authorities.
  const trustedName = (req: http.IncomingMessage) =>
    opts.allowedHosts.find((h) => req.headers.host === `${h}:${port}`) ?? null;

  const upstreamUrl = (): URL | string => {
    const target = opts.target();
    if (!target) return "no UI target is set";
    const parsed = parseUiTarget(target);
    return parsed.ok ? new URL(parsed.url) : parsed.reason;
  };
  // URL.hostname keeps IPv6 brackets; sockets want them stripped.
  const dialHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "");
  const dialPort = (u: URL) => Number(u.port || 80);

  const plain = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(text + "\n");
  };

  const server = http.createServer((req, res) => {
    const name = trustedName(req);
    if (!name) return plain(res, 403, `Host "${req.headers.host ?? ""}" is not this desk.`);
    const proxyOrigin = `http://${name}:${port}`;
    const deskOrigin = `http://${name}:${opts.deskPort}`;
    const frameAncestors = `frame-ancestors ${deskOrigin}`;
    const pathname = (req.url ?? "/").split("?")[0]!;

    if (pathname.startsWith(RESERVED_PREFIX)) {
      if (req.method === "GET" && pathname === BRIDGE_PATH) {
        void opts.bridgeJs().then(
          (js) => {
            if (js === null) return plain(res, 404, "The bridge bundle is not built.");
            res.writeHead(200, {
              "content-type": "text/javascript; charset=utf-8",
              "cache-control": "no-cache",
            });
            res.end(js);
          },
          () => plain(res, 500, "Could not read the bridge bundle."),
        );
        return;
      }
      if (req.method === "GET" && pathname === HEALTH_PATH) {
        // Always a 200 carrying {up}: a non-2xx would log a console error on every 2 s retry.
        const answer = (up: boolean) => {
          if (res.headersSent) return;
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ up }));
        };
        const upstream = upstreamUrl();
        if (typeof upstream === "string") return answer(false);
        const probe = net.connect(dialPort(upstream), dialHost(upstream));
        probe.setTimeout(1500, () => probe.destroy());
        probe.once("connect", () => {
          answer(true);
          probe.destroy();
        });
        probe.once("error", () => {}); // reported by "close" below
        probe.once("close", () => answer(false));
        return;
      }
      return plain(res, 404, "Not found.");
    }

    const upstream = upstreamUrl();
    if (typeof upstream === "string") return plain(res, 502, `Galley UI proxy: ${upstream}.`);

    const document = isDocumentRequest(req);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    // The dev server sees itself addressed directly: dev-auth and origin checks (better-auth) key
    // on Host/Origin matching its own configured origin.
    headers.host = upstream.host;
    if (headers.origin) headers.origin = upstream.origin;
    if (typeof headers.referer === "string" && headers.referer.startsWith(proxyOrigin))
      headers.referer = upstream.origin + headers.referer.slice(proxyOrigin.length);
    const encoding = narrowAcceptEncoding(req.headers["accept-encoding"]);
    if (encoding) headers["accept-encoding"] = encoding;
    else delete headers["accept-encoding"];
    // An injected page embeds this desk process's token, so a cached copy must never be revived
    // by a 304 — always fetch documents whole.
    if (document) {
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }

    const up = http.request({
      hostname: dialHost(upstream),
      port: dialPort(upstream),
      method: req.method,
      path: req.url,
      headers,
    });
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on("error", () => {
      if (res.headersSent) return void res.destroy();
      if (document && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(502, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": frameAncestors,
        });
        return void res.end(req.method === "HEAD" ? undefined : waitingPage(upstream.href));
      }
      plain(res, 502, `Galley UI proxy: the dev server at ${upstream.origin} is not answering.`);
    });
    up.on("response", (ur) => {
      const status = ur.statusCode ?? 502;
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(ur.headers))
        if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
      if (typeof out.location === "string")
        out.location = rewriteLocation(out.location, upstream, proxyOrigin);
      if (ur.headers["set-cookie"])
        out["set-cookie"] = ur.headers["set-cookie"].map((c) =>
          rewriteSetCookie(c, !isLoopbackHostname(name)),
        );
      const html = /^\s*text\/html/i.test(String(ur.headers["content-type"] ?? ""));
      if (html) {
        // The app must render inside the desk: its own framing policy goes, replaced by one that
        // admits exactly the desk origin (and nothing else may frame the proxied app).
        delete out["x-frame-options"];
        delete out["content-security-policy-report-only"];
        out["content-security-policy"] = frameAncestors;
      }
      const decoder = decoderFor(ur.headers["content-encoding"] as string | undefined);
      const inject =
        html &&
        document &&
        req.method !== "HEAD" &&
        status !== 204 &&
        status !== 304 &&
        decoder !== undefined;
      if (!inject) {
        res.writeHead(status, out);
        pipeline(ur, res, () => {});
        return;
      }
      delete out["content-length"];
      delete out["content-encoding"];
      delete out["etag"];
      delete out["last-modified"];
      res.writeHead(status, out);
      const tag = `<script src="${BRIDGE_PATH}" data-galley-desk="${escapeHtml(deskOrigin)}" data-galley-token="${escapeHtml(opts.token)}"></script>`;
      if (decoder) pipeline(ur, decoder, injectStream(tag), res, () => {});
      else pipeline(ur, injectStream(tag), res, () => {});
    });
    req.pipe(up);
  });

  // Websocket upgrades (live reload on the proxied origin): the same Host guard, plus an Origin
  // check — a browser always sends Origin on a websocket handshake, and only the proxied app's own
  // origin may open one (cross-site websocket hijacking). Then raw byte piping both ways.
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.on("error", () => socket.destroy());
    const name = trustedName(req);
    const origin = req.headers.origin;
    if (!name || (origin && !opts.allowedHosts.some((h) => origin === `http://${h}:${port}`)))
      return refuse("403 Forbidden");
    const upstream = upstreamUrl();
    if (typeof upstream === "string") return refuse("502 Bad Gateway");
    const conn = net.connect(dialPort(upstream), dialHost(upstream));
    let connected = false;
    conn.on("error", () => (connected ? socket.destroy() : refuse("502 Bad Gateway")));
    conn.on("connect", () => {
      connected = true;
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i]!;
        const lower = key.toLowerCase();
        const value =
          lower === "host"
            ? upstream.host
            : lower === "origin"
              ? upstream.origin
              : req.rawHeaders[i + 1];
        lines.push(`${key}: ${value}`);
      }
      conn.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) conn.write(head);
      upgraded.add(socket);
      socket.on("close", () => {
        upgraded.delete(socket);
        conn.destroy();
      });
      conn.on("close", () => socket.destroy());
      socket.pipe(conn).pipe(socket);
    });
  });

  port = await listenNextFree(server, opts.host, opts.port);
  return {
    server,
    port,
    close: () => {
      server.close();
      server.closeAllConnections();
      for (const s of upgraded) s.destroy();
    },
  };
}

// Bind the preferred port, else the next few, else a random one — a restarted desk normally gets
// its stable port back, and a foreign process holding it never fails the launch.
async function listenNextFree(server: http.Server, host: string, preferred: number) {
  const candidates = preferred ? Array.from({ length: 10 }, (_, i) => preferred + i) : [];
  for (const candidate of [...candidates, 0]) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(candidate, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (candidate === 0 || (code !== "EADDRINUSE" && code !== "EACCES")) throw error;
    }
  }
  throw new Error("unreachable: port 0 always binds or throws");
}
