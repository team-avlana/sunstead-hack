# WebView Shell & Data Path: Next.js + tldraw inside SwiftUI/WKWebView

_Last updated: 2026-06-24_

How to package the Rainy Canvas UI (Next.js App Router + tldraw, fully client-side) inside a SwiftUI + WKWebView macOS shell, how Swift and JS talk, how the Python Comms Service pushes real-time "pings", and how the canvas reads data from Postgres on Aiven. The same build must also run as a plain web app.

Versions verified 2026-06-24: **Next.js 16.2.x** (static-export docs are on 16.2.9), **tldraw 4.3.x**, **MCP spec 2025-11-25** (Streamable HTTP). macOS shell targets macOS 27 ("Tahoe"-class), WebKit/WKWebView. Flagged items below are beta/uncertain.

## TL;DR / Recommendation

- **Packaging:** Ship a **static export** (`output: 'export'`) of the Next.js app and load it in WKWebView via a **custom `WKURLSchemeHandler`** (e.g. `app-resource://`), *not* `loadFileURL` (which breaks `fetch`/relative routing and triggers file-URL CORS pain). tldraw is 100% client-side, so this works. In **dev**, point WKWebView at `http://localhost:3000` from `next dev`. **Do NOT bundle a Node `next start` server** — it adds a process to manage, a port, sandbox/entitlement surface, and buys you nothing because we deliberately keep DB access out of the WebView (see Data Path). The *same* static bundle is what you deploy as the plain web app.
- **Real-time pings:** Use **SSE** (Server-Sent Events) from the Comms Service to the canvas for the one-way "apply these batched ops" stream. It rides plain HTTP, auto-reconnects with `Last-Event-ID` for gap-free resume, and is exactly the shape MCP's Streamable HTTP already speaks (`text/event-stream` on a GET). The canvas→server direction (rare: acks, user edits) goes over normal `fetch` POSTs. Reach for WebSocket only if you later need high-rate *bidirectional* streaming.
- **Data read path:** A WebView/browser **cannot** open a raw Postgres TCP connection — ever. Reads go through an HTTP API. Given we chose a *static* export (no Node server in the bundle), the Postgres reads should go through the **Python Comms Service HTTP API** (which already holds the Aiven secret and runs server-side). We therefore **do not need a Next.js Node server in the bundle.** (If you instead wanted Next.js to own DB access, you'd be forced into bundling `next start` — a worse trade here.)

---

## 1. Packaging Next.js (App Router) inside WKWebView

### 1.0 Why tldraw makes this easy

tldraw renders, stores, and mutates entirely on the client (canvas + IndexedDB/local persistence; multiplayer is a separate WebSocket/sync concern we are not using for the shell). There is **no per-request server rendering requirement** for the canvas itself. That means the Next.js app can be reduced to a **static SPA-style export**, and all "server" work (DB, agent, real-time) lives in the **Python Comms Service**, not in Next.js. This is the key architectural simplification.

### 1.1 DEV — load `next dev` over localhost

Run the Next.js dev server normally (`next dev`, default `http://localhost:3000`) and point the WebView at it. You get HMR, fast refresh, and React DevTools.

```swift
// DEV configuration
#if DEBUG
let startURL = URL(string: "http://localhost:3000")!
webView.load(URLRequest(url: startURL))
#else
let startURL = URL(string: "app-resource://app/index.html")! // PROD, see §1.3
webView.load(URLRequest(url: startURL))
#endif
```

Gotchas for dev:
- **App Sandbox + outbound network:** loading `http://localhost` requires the **`com.apple.security.network.client`** entitlement. WKWebView runs out-of-process and needs this entitlement *even to load local content*, so you need it regardless.
- **ATS (App Transport Security):** `http://localhost` is plaintext. ATS permits `localhost` loopback by default in current macOS, but if you hit a block add an `NSAppTransportSecurity` → `NSAllowsLocalNetworking` exception (do **not** use `NSAllowsArbitraryLoads`). Keep this dev-only.
- This dev path is identical to "running as a plain web app" — same `next dev`, just a browser instead of the WebView.

### 1.2 PROD option A — bundle a Node server running `next start` (NOT recommended here)

You ship a Node runtime + the `.next` build inside the `.app`, spawn `next start` on a localhost port at launch, and load `http://localhost:<port>`.

| Pros | Cons |
|---|---|
| Full Next.js server: Route Handlers, Server Actions, SSR, middleware | Must bundle/manage a **Node runtime + process lifecycle** (start, port collision, crash/restart, shutdown) inside the sandbox |
| One place for DB access (if you wanted Next.js to own Postgres) | Larger bundle; codesigning/notarizing an embedded Node binary; another sandboxed helper to reason about |
| | Startup latency (spawn + listen) before first paint |
| | Duplicates the Python sidecar you already run — two long-lived local servers |

You'd only choose this if **Next.js itself must do server work** (DB queries, secrets, server rendering). In Rainy that work is owned by the Python Comms Service, so a Node server is redundant. See the sibling note `python-sidecar-in-mac-app.md` for how the Python process is already managed — adding a second server is the thing to avoid.

### 1.3 PROD option B — static export served via a custom scheme handler (RECOMMENDED)

`next build` with `output: 'export'` emits a self-contained `out/` of HTML/CSS/JS. Bundle `out/` as an app resource and serve it to WKWebView.

`next.config.ts`:
```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',          // emits ./out as static HTML/CSS/JS
  trailingSlash: true,       // emit /foo/index.html so dir-style URLs resolve cleanly
  images: { unoptimized: true }, // no server image optimizer in a static export
  // distDir: 'out' is the default for export
}
export default nextConfig
```

**Do not load it with `loadFileURL`.** `file://` URLs in WKWebView are origin-`null`/opaque, which breaks `fetch()` of your own JSON/chunks, breaks relative SPA routing for deep links, and makes CORS/`crossOrigin` behavior unpredictable. Instead register a **`WKURLSchemeHandler`** for a private scheme (e.g. `app-resource://`). This gives the page a real, stable origin you control, so `fetch`, history routing, and same-origin checks behave like a normal site.

```swift
import WebKit

final class AppResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    // Root of the exported Next.js `out/` copied into the app bundle.
    private let root = Bundle.main.url(forResource: "out", withExtension: nil)!

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }

        // Map app-resource://app/<path> -> out/<path>; default to index.html (SPA fallback).
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        var fileURL = root.appendingPathComponent(path)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            // Deep-link fallback: serve index.html so the client router can take over.
            fileURL = root.appendingPathComponent("index.html")
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime = Self.mimeType(for: fileURL.pathExtension)
        let resp = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime,
                           "Cache-Control": "no-cache",
                           "Access-Control-Allow-Origin": "*"] // tighten as needed
        )!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { /* no-op for in-memory reads */ }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}
```

Registration (must happen on the **configuration before** the `WKWebView` is created):
```swift
let config = WKWebViewConfiguration()
config.setURLSchemeHandler(AppResourceSchemeHandler(), forURLScheme: "app-resource")
// ... add script message handlers here too (see §2) ...
let webView = WKWebView(frame: .zero, configuration: config)
webView.load(URLRequest(url: URL(string: "app-resource://app/index.html")!))
```

Notes / gotchas:
- The scheme **must be a custom one** WebKit doesn't already handle. You cannot register handlers for `http`/`https`/`file`. Pick something like `app-resource` or `rainy-app`.
- Because tldraw uses **IndexedDB/localStorage**, a stable non-opaque origin (which the custom scheme gives you) is required for that storage to persist correctly. `file://` origins are unreliable for storage.
- Set `images: { unoptimized: true }` (or a custom loader) — the default `next/image` optimizer needs a server and is unsupported in static export.
- **App Sandbox:** keep `out/` as read-only bundle resources; you only need read access. The network-client entitlement (§2.4) is still required because WKWebView is out-of-process.
- The `out/` folder is exactly what you upload to any static host (S3+CloudFront, Vercel static, Nginx) for the **plain web app** target. One artifact, two delivery paths.

### 1.4 What static export forbids (and why it's fine for us)

Per the Next.js static-export docs, these are **unsupported** with `output: 'export'`: Server Actions, dynamic Route Handlers that read the `Request`, `cookies()`/`headers()`, `redirect`/`rewrite`/`headers` config, middleware/proxy, ISR, Draft Mode, intercepting routes, and default-loader image optimization. Route Handlers may only emit **static** `GET` responses at build time. Server Components still run **at build time** only.

None of these matter for Rainy because **the canvas does no server work** — data and real-time both come from the Python Comms Service over HTTP/SSE at runtime, fetched client-side (e.g. with SWR). If a future feature genuinely needs a Next.js server route, that is the trigger to reconsider Option A (bundle `next start`) — flag it then, not now.

---

## 2. The JS ↔ Swift bridge

Two directions: **JS → Swift** (page asks the shell to do native things) and **Swift → JS** (shell pushes events/commands into the page). Use a small typed protocol so neither side stringly-types message names.

### 2.1 JS → Swift, fire-and-forget (`WKScriptMessageHandler`)

Register a named handler on the configuration's `userContentController`; the page posts to `window.webkit.messageHandlers.<name>.postMessage(...)`.

```swift
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        // message.body is JSON-bridged: NSString/NSNumber/NSArray/NSDictionary/NSNull
        guard let dict = message.body as? [String: Any],
              let type = dict["type"] as? String else { return }
        switch type {
        case "openExternalURL":
            if let s = dict["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
        case "setWindowTitle":
            // window management example
            (NSApp.keyWindow)?.title = dict["title"] as? String ?? "Rainy"
        default: break
        }
    }
}

// registration (on the same `config` used in §1.3)
let bridge = NativeBridge()
config.userContentController.add(bridge, name: "rainy") // -> window.webkit.messageHandlers.rainy
```

```ts
// browser side — guarded so the SAME build runs in a plain browser (no shell)
type NativeMsg =
  | { type: 'openExternalURL'; url: string }
  | { type: 'setWindowTitle'; title: string }

const native = (window as any).webkit?.messageHandlers?.rainy
export function postNative(msg: NativeMsg): void {
  native?.postMessage(msg)        // no-op in a plain browser
}
```

### 2.2 JS → Swift with an async reply (`WKScriptMessageHandlerWithReply`)

For things the page needs a value back from (file picker result, native capability check), use `WKScriptMessageHandlerWithReply` (**macOS 11+ / iOS 14+**). On the JS side `postMessage` returns a **Promise**.

Swift reply-handler signature is `(replyHandler: @escaping (Any?, String?) -> Void)` — first arg is the result value, second is an **error string** (non-nil rejects the JS promise):

```swift
final class ReplyBridge: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let dict = message.body as? [String: Any],
              let type = dict["type"] as? String else {
            replyHandler(nil, "bad message"); return
        }
        switch type {
        case "pickVideoFile":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie]
            panel.begin { resp in
                if resp == .OK, let url = panel.url {
                    replyHandler(["path": url.path], nil)   // resolves JS promise
                } else {
                    replyHandler(nil, "cancelled")          // rejects JS promise
                }
            }
        default:
            replyHandler(nil, "unknown type \(type)")
        }
    }
}

// register into a specific content world (recommended: .page for app code)
config.userContentController.addScriptMessageHandler(
    ReplyBridge(), contentWorld: .page, name: "rainyAsync")
```

```ts
// browser side
export async function pickVideoFile(): Promise<{ path: string } | null> {
  const h = (window as any).webkit?.messageHandlers?.rainyAsync
  if (!h) return null               // plain browser fallback
  try {
    return await h.postMessage({ type: 'pickVideoFile' })   // Promise
  } catch (err) {
    console.warn('native pick cancelled/failed', err)
    return null
  }
}
```

Concurrency gotcha (Swift 6 / strict concurrency): `WKScriptMessage` is not `Sendable` and its `.body` must be touched on the **main thread**; the protocol method isn't `@MainActor`. Read `message.body` synchronously at the top of the method (or wrap with `MainActor.assumeIsolated`) before hopping off-thread, and call `replyHandler` exactly once.

### 2.3 Swift → JS (`evaluateJavaScript`)

The shell pushes events into the page by calling a global the page installed, or by dispatching a `CustomEvent`.

```swift
func sendToWeb(_ event: String, _ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    let js = "window.__rainyNative?.receive(\(json.asJSStringLiteral), '\(event)')"
    DispatchQueue.main.async {                 // evaluateJavaScript must run on main
        self.webView.evaluateJavaScript(js) { _, err in
            if let err { NSLog("evaluateJavaScript error: \(err)") }
        }
    }
}
```

```ts
// browser side: install a receiver the shell can call
;(window as any).__rainyNative = {
  receive(payloadJson: string, event: string) {
    const detail = JSON.parse(payloadJson)
    window.dispatchEvent(new CustomEvent(`native:${event}`, { detail }))
  },
}
// e.g. native menu shortcut -> canvas action
window.addEventListener('native:zoomToFit', () => editor.zoomToFit())
```

This is the channel for **native shortcuts** (macOS menu / `Cmd+` key bound in SwiftUI → `evaluateJavaScript` → tldraw editor command) and **window management** signals (fullscreen toggled, focus changed). Always sanitize/escape strings you inject; prefer JSON-encoding the whole payload rather than string concatenation of user data.

### 2.4 WKWebView gotchas checklist

- **Entitlement:** `com.apple.security.network.client` is **mandatory** for WKWebView in a sandboxed app — even when only loading bundled/local content, because the web content runs in a separate process. (App Review may ask why; "uses WKWebView" is the reason.)
- **Custom scheme + CORS:** with the `WKURLSchemeHandler` origin (§1.3), `fetch` to the **Comms Service** is cross-origin. Either (a) have the Comms Service send permissive `Access-Control-Allow-Origin` for the app's scheme/origin, or (b) front it so the page treats it same-origin. SSE (`EventSource`) is also subject to CORS — the SSE endpoint needs the right `Access-Control-Allow-Origin`/credentials headers.
- **localhost in dev:** needs network-client entitlement + (if blocked) `NSAllowsLocalNetworking`. Don't ship arbitrary-loads.
- **Content worlds:** register reply handlers in an explicit `WKContentWorld` (`.page` for your app JS, or an isolated world if you want to hide the bridge from page scripts). Mixing worlds silently makes handlers "not found".
- **Single registration point:** all scheme handlers and message handlers must be set on the `WKWebViewConfiguration` **before** the `WKWebView` is instantiated.

---

## 3. Real-time "pings" from the Python Comms Service

The Comms Service mutates the canvas and must push **batched canvas ops** to the UI in real time. This is predominantly **server → client, one-way**.

### 3.1 SSE vs WebSocket for this stream

| | SSE (`text/event-stream`) | WebSocket |
|---|---|---|
| Direction | Server → client only (client→server via separate `fetch`) | Full-duplex |
| Transport | Plain HTTP/1.1 or HTTP/2 (GET) | TCP upgrade (`ws://`/`wss://`) |
| Reconnect | **Built in** + `Last-Event-ID` resume | Manual (you write backoff + resume) |
| Infra friendliness | Works through CDNs/proxies/HTTP auth; no special proxy config (just disable buffering) | Often needs proxy/LB upgrade config |
| Fit with MCP Streamable HTTP | **Native** — MCP already streams `text/event-stream` on GET | Not what MCP speaks |
| Binary | Text only (base64 if needed) | Binary frames |

For "apply these batched ops" (a server-push feed), **SSE wins**: simpler, auto-reconnecting with gap-free `Last-Event-ID` resume, CORS/auth via normal HTTP headers, and it is *literally the same wire format* the **MCP Streamable HTTP** transport (spec **2025-11-25**) uses when the server streams notifications. The rare client→server messages (user edits the agent should see, acks) go over ordinary `fetch` POSTs to the Comms Service. Choose **WebSocket only** if a later feature needs sustained high-rate *bidirectional* streaming (e.g. live cursor co-editing) — not the case for one-way pings.

> Note: MCP's Streamable HTTP exposes a single endpoint that handles POST (JSON-RPC in) and GET (opens an SSE stream for server→client notifications/requests). Our "pings" are exactly those server→client notifications. If the canvas is itself an MCP client, you can consume them through the MCP client lib; if you want a thinner path, expose a dedicated SSE route on the Canvas Backend that emits the same op batches. Both are SSE on the wire.

### 3.2 Minimal browser-side SSE client

Native `EventSource` is the simplest, but it **can't set custom headers** (e.g. `Authorization`) and gives poor error detail. For token auth, prefer a **fetch-based SSE reader** (e.g. `@microsoft/fetch-event-source` or `eventsource-parser`). Both shown:

```ts
// Simple: native EventSource (auth via cookie or query token; auto-reconnect built in)
function connectPingsSimple(onOps: (ops: unknown[]) => void) {
  const es = new EventSource('https://comms.local/canvas/stream', { withCredentials: true })
  es.addEventListener('ops', (e) => onOps(JSON.parse((e as MessageEvent).data)))
  es.onerror = () => { /* EventSource auto-reconnects; surface a "reconnecting" UI state */ }
  return () => es.close()
}
```

```ts
// Preferred: fetch-based SSE — custom headers + Last-Event-ID resume + explicit retry control
import { fetchEventSource } from '@microsoft/fetch-event-source'

function connectPings(token: string, onOps: (ops: unknown[]) => void) {
  const ctrl = new AbortController()
  let lastId = localStorage.getItem('rainy:lastEventId') ?? ''
  fetchEventSource('https://comms.local/canvas/stream', {
    signal: ctrl.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(lastId ? { 'Last-Event-ID': lastId } : {}),
    },
    openWhenHidden: true, // keep streaming when tab/window not focused
    onmessage(ev) {
      if (ev.id) { lastId = ev.id; localStorage.setItem('rainy:lastEventId', ev.id) }
      if (ev.event === 'ops') onOps(JSON.parse(ev.data))
    },
    onerror(err) {
      // returning (not throwing) lets the lib back off and retry; throw to stop.
      console.warn('pings stream error, will retry', err)
    },
  })
  return () => ctrl.abort()
}
```

Apply ops into tldraw inside a single transaction so a batch is one undo step:
```ts
editor.run(() => { for (const op of ops) applyOp(editor, op) }, { history: 'record' })
```

### 3.3 Reconnection & auth

- **Resume, don't replay-from-zero:** server tags each SSE event with a monotonic `id:`; on reconnect the client sends `Last-Event-ID` (native `EventSource` does this automatically; with fetch you set the header yourself). Server replays only ops after that id from a short ring buffer. If the buffer can't cover the gap, send a `resync` event telling the client to re-pull full canvas state from the Data Path (§4).
- **Auth:** native `EventSource` can't set `Authorization`, so either use a cookie (works with `withCredentials`) or a short-lived query token — or use the fetch-based reader to send a bearer token. With the MCP transport, carry the **`MCP-Session-Id`** header the server issued at initialization on every request, including the GET that opens the stream.
- **CORS:** the SSE endpoint must return `Access-Control-Allow-Origin` for the WebView's custom-scheme origin (and `Access-Control-Allow-Credentials: true` if using cookies). See §2.4.
- **Heartbeats:** emit a comment line (`: ping\n\n`) every ~15–30 s so idle proxies/the WebView don't drop the connection; disable proxy buffering on the stream.

---

## 4. Data path: "Canvas UI loads data from Postgres (Aiven)"

### 4.1 Hard constraint: no raw Postgres from the browser/WebView

A browser/WKWebView page can only speak HTTP(S)/WS(S)/fetch-able protocols. The Postgres wire protocol is **raw TCP** (with TLS), which JS in a page **cannot** open — there is no socket API for it, and you must never embed DB credentials in client code anyway. So **every read goes through a server-side HTTP API.** Two candidates:

| | (a) Next.js server (Route Handler / Server Component / Server Action) + PG client | (b) Python Comms Service HTTP API |
|---|---|---|
| Where the Aiven secret lives | Next.js **server** env | Comms Service **server** env (already there) |
| Requires a Node server in the bundle? | **Yes** — forces Option A in §1.2 (static export can't do dynamic DB routes) | **No** — keeps the static export (§1.3) |
| New surface area | A second long-lived local server next to the Python sidecar | Reuses the service that already owns DB + agent + real-time |
| Consistency with real-time | DB and pings live in different processes | DB and pings live in the **same** process (one source of truth) |
| Web-app target | Needs Next.js server hosting (not just static CDN) | Static CDN for UI; API is the same Comms Service |

**Recommendation: route reads through the Python Comms Service HTTP API (b).** It already holds the Aiven connection and runs server-side, it's the same process emitting the real-time ops (so reads and pings are consistent), and crucially it lets us keep the **static export** packaging from §1.3 — i.e. **no Next.js Node server in the bundle.** The canvas fetches JSON over HTTP (client-side, with SWR for caching/revalidation):

```ts
'use client'
import useSWR from 'swr'
const fetcher = (u: string) => fetch(u, { credentials: 'include' }).then(r => r.json())

export function useCanvas(canvasId: string) {
  // GET against the Comms Service; CORS must allow the app-resource:// origin (§2.4)
  return useSWR(`https://comms.local/api/canvas/${canvasId}`, fetcher)
}
```

Choose (a) **only** if you have a reason for Next.js to own the DB (e.g. you're hosting the web target on Vercel and want server components reading Postgres at request time). That decision **forces** bundling `next start` in the Mac app (§1.2) and is the heavier path — flag it explicitly if pursued.

### 4.2 Aiven Postgres connection specifics (server-side only)

Aiven for PostgreSQL **requires TLS**. The connection string uses `sslmode`; for real verification use `verify-full` (or `verify-ca`) with Aiven's **project CA certificate** (`ca.pem`, downloaded from the service overview page). `sslmode=require` encrypts but does **not** verify the server cert — prefer `verify-full`.

If the server is **Python** (Comms Service), with `asyncpg`/`psycopg`:
```python
# Python (Comms Service) — secret comes from env, NEVER shipped to client
import os, ssl, asyncpg

ssl_ctx = ssl.create_default_context(cafile=os.environ["AIVEN_PG_CA"])  # path to ca.pem
ssl_ctx.check_hostname = True
ssl_ctx.verify_mode = ssl.CERT_REQUIRED

pool = await asyncpg.create_pool(
    dsn=os.environ["DATABASE_URL"],  # postgres://USER:PASS@HOST:PORT/DB?sslmode=verify-full
    ssl=ssl_ctx,
    min_size=1, max_size=10,
)
```

If you *did* go the Next.js-server route (option a), the equivalent with node-`pg` (per Aiven's Node docs) is:
```ts
// server-only module (Route Handler / server component) — NEVER imported by client code
import { Pool } from 'pg'
import fs from 'node:fs'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // ...?sslmode=verify-full
  ssl: {
    rejectUnauthorized: true,                 // verify the server cert
    ca: fs.readFileSync(process.env.AIVEN_PG_CA!).toString(), // Aiven project ca.pem
  },
  max: 10,
})
```
Drizzle/Prisma wrap the same connection string + CA; the TLS requirements are identical. (Aiven's own Node example uses `rejectUnauthorized: true` + `ca: fs.readFileSync('./ca.pem')`.)

### 4.3 Where the secret lives

- The Aiven **connection URL + password + CA path** live in **server env only**: the Comms Service process environment (or a secrets manager it reads). On the Mac, that's the Python sidecar's environment — see `python-sidecar-in-mac-app.md` for how the sidecar's env/secrets are provisioned.
- **Never** put the connection string, password, or even the CA in the Next.js client bundle. In a static export there is *no* server env at all on the client side, which is a feature: there's no place for the secret to leak into. Anything in the `out/` bundle is fully public.
- The CA cert (`ca.pem`) is not secret, but the username/password/host are — keep the whole DSN out of any client-reachable file.

---

## Open questions / flagged items

- **macOS 27 WebKit specifics** (exact ATS-localhost defaults, any new content-world rules) — verify against the shipping SDK; behavior described here matches recent WebKit but confirm on the target OS. (uncertain)
- **MCP spec 2025-11-25** is the current Streamable HTTP spec as of writing; confirm no newer revision changed session-header/SSE semantics before implementing the ping consumer. (verify)
- **tldraw 4.3.x** op/transaction APIs (`editor.run`, store changes) are stable but evolving — pin the version and re-check the `run`/history options signature. (verify)
- **`@microsoft/fetch-event-source`** is widely used but lightly maintained; `eventsource-parser` + a hand-rolled fetch loop is an alternative if you want fewer deps. (uncertain)
- If a future canvas feature truly needs a Next.js *server* route, revisit §1.2 (bundle `next start`) — that's the single trigger that changes the packaging recommendation.

## Sources

- Next.js — Static Exports guide (`output: 'export'`, supported/unsupported features): https://nextjs.org/docs/app/guides/static-exports
- Next.js — App Router docs: https://nextjs.org/docs/app
- Next.js — "API Routes in Static Export" warning: https://nextjs.org/docs/messages/api-routes-static-export
- Apple — `WKURLSchemeHandler`: https://developer.apple.com/documentation/webkit/wkurlschemehandler
- Apple — `WKScriptMessageHandlerWithReply`: https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply
- Apple — `com.apple.security.network.client` entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.client
- Apple — App Sandbox entitlements: https://developer.apple.com/documentation/security/app_sandbox_entitlements
- Apple Developer Forums — WKWebView requires network-client entitlement: https://developer.apple.com/forums/thread/116359
- Apple Developer Forums — App Sandbox outgoing connections: https://developer.apple.com/forums/thread/744961
- Gualtiero Frigerio — Custom URL schemes in a WKWebView (WKURLSchemeHandler example): https://www.gfrigerio.com/custom-url-schemes-in-a-wkwebview/
- WKWebView ↔ JavaScript communication walkthrough: https://www.joaoaleixo.com/writing/wkwebview-javascript-communication/
- Messaging between WKWebView and native app in SwiftUI: https://medium.com/@yeeedward/messaging-between-wkwebview-and-native-application-in-swiftui-e985f0bfacf
- Model Context Protocol — Transports (Streamable HTTP, 2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Auth0 — Why MCP moved to Streamable HTTP: https://auth0.com/blog/mcp-streamable-http/
- WebSocket.org — WebSocket vs SSE: https://websocket.org/comparisons/sse/
- Ably — WebSockets vs Server-Sent Events: https://ably.com/blog/websockets-vs-sse
- MDN — Using server-sent events / EventSource: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Aiven — Connect to Aiven for PostgreSQL with Node.js: https://aiven.io/docs/products/postgresql/howto/connect-node
- Aiven — TLS/SSL certificates: https://aiven.io/docs/platform/concepts/tls-ssl-certificates
- PostgreSQL — libpq SSL support / sslmode: https://www.postgresql.org/docs/current/libpq-ssl.html
- tldraw — Persistence & store docs: https://tldraw.dev/docs/persistence
- node-postgres (`pg`) docs: https://node-postgres.com/
