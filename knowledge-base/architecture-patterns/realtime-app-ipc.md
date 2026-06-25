# Real-Time IPC: SwiftUI App ↔ Python Sidecar

_Last updated: 2026-06-24_

Low-latency IPC between Rainy (native SwiftUI, macOS 27) and its bundled Python FastMCP sidecar, plus pushing live updates into SwiftUI. Scenario: the Python agent mutates a shared "canvas" and the UI must reflect it in ~real time (target: well under one frame at 60–120 Hz).

## TL;DR / Recommendation

**Reuse the existing stdio pipe.** The MCP stdio transport is already a bidirectional newline-delimited JSON-RPC channel. Push canvas mutations as **JSON-RPC notifications** on that same channel. On the Swift side, run a `bytes.lines` read loop that feeds an `AsyncStream` (`.bufferingNewest`) whose consumer hops to `@MainActor` and mutates an `@Observable` model. Lowest latency, lowest complexity, zero extra surface area.

**Secondary/fallback:** a Swift-hosted local WebSocket server (Network.framework `NWListener`) when you need fan-out to multiple consumers or an out-of-band high-rate stream.

**Pair with SQLite only for persistence** — SQLite has no cross-process push, so the *notification* still rides the pipe.

## 1. IPC options compared

| Option | One-way latency | Complexity | Bidirectional | Notes |
|---|---|---|---|---|
| **stdio pipe (reuse MCP)** | ~tens of µs (kernel pipe) | **Lowest** — already exists | Yes (stdin+stdout) | JSON-RPC notifications; no new ports/sockets/entitlements |
| Unix domain socket | ~130 µs RT class | Medium | Yes | ~50% lower latency than TCP loopback; local-only |
| TCP loopback | ~330 µs RT class | Medium | Yes | Traverses full net stack; only for cross-machine |
| Swift-hosted local WS/HTTP | sub-ms + WS framing | Medium-High | Yes | Great for fan-out / multiple clients |
| XPC | µs-class | High | Apple-only | **Cannot** talk to Python — see §1.3 |
| NSDistributedNotificationCenter | ms, best-effort | Low | Notifications only | Sandbox forbids `userInfo` payload — see §1.4 |
| FSEvents file watch | ~2–4 ms + coalescing | Low-Med | One-way | Coalesces bursts; tree scope |
| DispatchSource file watch | ~ms, no coalescing | Medium | One-way | Atomic-write inode gotcha |
| Shared SQLite + observe | ms + poll/notify | Medium-High | One-way | Durable; still needs a change signal |

Socket µs figures are cross-source benchmark order-of-magnitude (Node/uvloop/fluentd), not macOS-27-specific. The relative ordering **pipe ≈ UDS < TCP loopback** is consistent. Profile your own payloads.

### 1.1 Local sockets: TCP loopback vs Unix domain sockets
UDS bypasses the TCP/IP stack and uses the kernel IPC path via the filesystem namespace — ~30–66% lower latency, up to ~7× throughput vs TCP localhost (one benchmark: 334 µs TCP vs 130 µs UDS round-trip). TCP loopback only earns its keep if you might go cross-machine. UDS is strictly local. Both are full-duplex byte streams; you frame messages yourself (newline-delimited JSON or length-prefix). **Verdict:** fine if you weren't already on stdio — but you are (§1.7), so a socket is strictly more setup with no meaningful latency win.

### 1.2 Swift app hosting a local HTTP/WebSocket server (Python calls in)
The Swift app is the **server**; the Python tool connects as a client (`websockets`/`httpx`) and posts mutations. Good for fan-out to multiple subscribers or a clean separation from the MCP control channel.

Swift options: **Network.framework `NWListener` + `NWProtocolWebSocket.Options`** (native, no dep — set `allowLocalEndpointReuse = true`, `autoReplyPing = true`, accept in `newConnectionHandler`, broadcast frames); or packages (Hummingbird = light modern choice, Vapor = batteries-included, Swifter = tiny). For an in-app control plane, Network.framework keeps the dependency surface minimal.

Security: bind `127.0.0.1` only; validate `Origin` if you ever accept browser clients (MCP guidance warns about DNS-rebinding on local servers). **Verdict:** excellent *secondary* channel; more moving parts than the pipe (port lifecycle/collision, handshake).

### 1.3 XPC — cannot talk to Python (clarification)
`NSXPCConnection`/`xpc_*` requires the peer to be a launchd-managed Mach service using Apple's XPC runtime/serialization. A generic Python subprocess is **not** an XPC peer and cannot connect. You could write a Swift XPC helper that itself bridges to Python over a pipe/socket — but that just reintroduces a non-XPC channel plus indirection. **For Swift↔Python, XPC is the wrong tool.**

### 1.4 NSDistributedNotificationCenter — limited, payload-blocked under sandbox
Broadcasts named notifications machine-wide, but if the sender is sandboxed, `userInfo` **must be `nil`** — you cannot ship the mutation, only a "something changed" doorbell. Delivery is best-effort/coalescable, not for high-rate/ordered streaming, and a known privacy leak surface. Your Python process is not a Cocoa app and cannot easily post one without a bridge. **Verdict:** not viable as the data channel.

### 1.5 File-watching: FSEvents vs DispatchSource
Agent atomically writes canvas state to a shared file; app watches it.
- **FSEvents** (`FSEventStreamCreate` + `FSEventStreamSetDispatchQueue`): tree monitoring, configurable `latency` that coalesces bursts. Observed ~2–4 ms detection with `latency = 0.01`. A single op can emit multiple events — dedupe. Good power profile.
- **DispatchSource** (`makeFileSystemObjectSource`): single fd, no built-in coalescing. **Atomic-write gotcha:** atomic saves delete+replace → new inode → your fd points at the gone inode and stops firing. You must cancel and re-arm on `.delete`/`.rename`/`.link`. Since agents usually write atomically, this bites you; FSEvents (path-based) sidesteps it.

**Verdict:** workable but adds file I/O + atomic-write churn + coalescing latency vs an in-memory push. Use only if you also want durable persistence as a side effect.

### 1.6 Shared store (SQLite) + app observes
Durable and queryable, but **SQLite gives no cross-process push** — you still need a signal (poll, watch `-wal`, or a side-channel). The SQLite `update_hook` is in-process only. So you combine store + (pipe/socket) anyway. **Verdict:** right answer for *persistence*, not *notification*. Pair it: Python writes SQLite for durability **and** sends a JSON-RPC notification over stdout for instant UI update.

### 1.7 ★ Reuse the existing stdio pipe (recommended primary)
The MCP stdio transport is **already** a bidirectional newline-delimited JSON-RPC channel. Per spec: server reads JSON-RPC from stdin, writes to stdout; messages are newline-delimited, must not contain embedded newlines, must be UTF-8; the server **MUST NOT** write non-MCP data to stdout (logging → stderr). JSON-RPC defines requests (have `id`), responses, and **notifications** (no `id`, fire-and-forget) — **a notification is exactly the server-initiated push primitive you want.** The server can emit notifications on stdout at any time, outside the request/response cycle.

Encode each canvas mutation as a JSON-RPC notification (e.g. method `"canvas/mutated"`, diff in `params`). The Swift MCP client already reads stdout line-by-line; route notification methods to your canvas handler.

**FastMCP (Python side):** server→client messaging is via the `Context` object — `ctx.report_progress(...)`, `ctx.session.send_log_message(level, data, logger)`, and progress notifications are stable. For a *custom* notification method you may need to drop to the underlying `ServerSession`/`anyio` send.

> ⚠️ **Uncertain — verify against your pinned version:** the exact public FastMCP API for a fully custom JSON-RPC notification method (beyond built-in `notifications/message` and `notifications/progress`) shifts across FastMCP/python-sdk releases. Built-in log/progress notifications are stable. Also ensure your Swift MCP client doesn't hard-reject unknown notification methods — you may need to register `canvas/mutated` in its dispatch table or reuse a known notification type.

Why this wins: zero new surface (no ports/sockets/entitlements/sandbox payload limits), lowest latency (anonymous kernel pipe is cheaper than UDS/TCP, no handshake), ordered + reliable, already bidirectional, already in the app's startup/teardown lifecycle. Caveat: single consumer — add the local WS server (§1.2) for fan-out. Keep payloads modest and newline-free.

## 2. Driving SwiftUI from the received update

Pipeline: **read loop (background) → AsyncStream → consumer task → `@MainActor` hop → mutate `@Observable` model → SwiftUI invalidates.**

- **Reading the channel async:** `FileHandle.bytes` is an `AsyncSequence` of `UInt8`; use `bytes.lines` to get whole JSON lines. For a socket, bridge `NWConnection.receive` callbacks into a continuation.
- **Imperative loop → AsyncStream:** `AsyncStream.makeStream(of:)` (Swift 5.9+) returns `(stream, continuation)` so you hold the continuation and `yield` from the read loop. Choose `.bufferingNewest(n)` so a burst of mutations drops stale frames — important for a canvas where only the latest state matters.
- **`@Observable` + MainActor:** Observation does not require MainActor isolation, but UI mutations must land on main. **Annotate the canvas model `@MainActor`** so the compiler enforces it. Hop with `await MainActor.run { ... }` or by calling a `@MainActor` method (preferred over `DispatchQueue.main.async` in concurrency code). Make the mutation/diff type `Sendable`; decode off-main, only the final assignment crosses to MainActor → minimal main-thread work, smooth frames.

### Swift sketch (stdio pipe → AsyncStream → @Observable canvas)

```swift
import Foundation

@MainActor @Observable
final class CanvasModel {
    var shapes: [Shape] = []
    func apply(_ mutation: CanvasMutation) { mutation.apply(to: &shapes) }
}

struct CanvasMutation: Codable, Sendable { func apply(to shapes: inout [Shape]) { /* ... */ } }
struct JSONRPCNotification: Decodable, Sendable { let method: String; let params: CanvasMutation? }

final class SidecarChannel {
    let mutations: AsyncStream<CanvasMutation>
    private let continuation: AsyncStream<CanvasMutation>.Continuation

    init(stdout: FileHandle) {
        (mutations, continuation) = AsyncStream.makeStream(
            of: CanvasMutation.self,
            bufferingPolicy: .bufferingNewest(64))   // coalesce bursts
        Task.detached { [continuation] in
            do {
                for try await line in stdout.bytes.lines {     // newline-delimited JSON-RPC
                    guard let data = line.data(using: .utf8),
                          let msg = try? JSONDecoder().decode(JSONRPCNotification.self, from: data),
                          msg.method == "canvas/mutated", let m = msg.params else { continue }
                    continuation.yield(m)                       // off-main; Sendable
                }
            } catch { /* log to your own facility, NOT stdout */ }
            continuation.finish()
        }
    }
}

@MainActor
func pump(_ channel: SidecarChannel, into model: CanvasModel) {
    Task {
        for await mutation in channel.mutations {  // hops to MainActor each iteration
            model.apply(mutation)                   // safe: model is @MainActor
        }
    }
}
```

### Python (FastMCP) sketch

```python
import json

async def mutate_canvas(ctx, op: str, payload: dict):
    apply_locally(op, payload)                       # mutate server-side canvas
    # Preferred: custom JSON-RPC notification over the SAME stdio channel
    await ctx.session.send_notification(method="canvas/mutated",
                                        params={"op": op, "payload": payload})
    # Fallback that works everywhere: piggyback on the log-message notification
    # await ctx.session.send_log_message(level="info",
    #     data={"canvas/mutated": {"op": op, "payload": payload}}, logger="canvas")
```

**CRITICAL (Python side):** never `print()` to stdout — it corrupts the JSON-RPC stream. All logging → stderr. One notification per line, no embedded newlines.

### Local WebSocket alternative (Swift hosts, Python connects)

```swift
import Network
let params = NWParameters(tls: nil)
params.allowLocalEndpointReuse = true
let ws = NWProtocolWebSocket.Options(); ws.autoReplyPing = true
params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
let listener = try NWListener(using: params, on: 8765)   // 127.0.0.1 only
listener.newConnectionHandler = { conn in
    conn.start(queue: .main)
    receive(on: conn)        // recv loop → continuation.yield → same pump()
}
listener.start(queue: .main)
```

Python: `websockets.connect("ws://127.0.0.1:8765")` and send the same JSON mutations. Use for fan-out or to isolate a high-rate stream from MCP control traffic.

## 3. Recommendation & rationale
**Primary: reuse the stdio pipe with JSON-RPC notifications** — already exists and is in the process lifecycle; lowest-latency local channel (kernel pipe < UDS < TCP loopback, no handshake); notifications are purpose-built for server→client push; clean modern Swift pipeline (`bytes.lines` → `makeStream` with `.bufferingNewest` → `@MainActor @Observable`).
**Secondary: Swift-hosted local WebSocket server** when you need fan-out, a separate high-rate stream, or browser/devtool clients.
**Pair with SQLite only for durability** (keep the notification on the pipe).
**Avoid:** XPC (can't reach Python), NSDistributedNotificationCenter (no sandboxed payload), file-watching as primary (inode churn + coalescing latency).

## Flagged uncertain / version-sensitive items
- FastMCP custom-notification API varies by version — verify your pin; built-in log/progress notifications are stable.
- Ensure the Swift MCP client doesn't reject unknown notification methods.
- 2026-toolchain claims (an `@Observable`→AsyncSequence convenience, stricter `Sendable`-on-yield) came from secondary blogs — verify on your Xcode/Swift; the patterns above need no beta feature.
- Socket latency µs numbers are cross-platform order-of-magnitude, not macOS-27 measurements.

## Sources
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://www.swifttoolkit.dev/posts/pipe
- https://nilcoalescing.com/blog/AsyncStreamFromWithObservationTrackingFunc/
- https://alexwlchan.net/2026/watch-files-on-macos/
- https://swiftrocks.com/dispatchsource-detecting-changes-in-files-and-folders-in-swift
- https://www.donnywals.com/dispatching-to-the-main-thread-with-mainactor-in-swift/
- https://medium.com/@michaelneas/swift-websockets-78008632e628
- https://developer.apple.com/documentation/swift/asyncstream
- https://developer.apple.com/documentation/network/nwprotocolwebsocket
- https://developer.apple.com/documentation/foundation/distributednotificationcenter
- https://www.donnywals.com/building-an-asyncsequence-with-asyncstream-makestream/
- https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix
- https://rderik.com/blog/xpc-services-on-macos-apps-using-swift/
- https://github.com/jlowin/fastmcp
