# Infinite Zoomable Canvas in SwiftUI (macOS)

_Last updated: 2026-06-24_

A practical reference for building an infinite, pan/zoom canvas of brainstorming nodes on
macOS with SwiftUI, where an **external AI agent mutates a shared state store and the view
updates live**. Targets macOS 26 (Tahoe) but notes back-deployment where it matters.

> Beta/uncertainty flags are marked **[verify]**. macOS 26 / SwiftUI "26" APIs (Liquid Glass,
> `scrollEdgeEffect`, etc.) were introduced at WWDC25 and are stable as of this writing, but
> confirm exact signatures against the current SDK before shipping.

---

## 1. Mental model: world space vs. screen space

The single most important decision. Keep **one source of truth: node positions in "world"
(canvas) coordinates** — unbounded `CGFloat`s, independent of zoom/scroll. The viewport is a
transform from world → screen:

```
screenPoint = (worldPoint - panOffset) * zoom        // (centered variants add view midpoint)
worldPoint  = screenPoint / zoom + panOffset
```

Store `panOffset: CGSize` (or `CGPoint`) and `zoom: CGFloat` as your *camera*. Everything
else — hit-testing, edge routing, agent mutations, persistence — happens in world space and is
zoom-agnostic. Never store node positions in screen pixels; you'll regret it the moment you
zoom or the window resizes.

A small value type makes conversions explicit and testable:

```swift
struct Viewport {
    var pan: CGPoint = .zero          // world point shown at view origin
    var zoom: CGFloat = 1.0           // 0.1 ... 4.0 typical clamp

    func toScreen(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - pan.x) * zoom, y: (p.y - pan.y) * zoom)
    }
    func toWorld(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x / zoom + pan.x, y: p.y / zoom + pan.y)
    }
    /// Zoom keeping the world point under `anchor` (screen) fixed — required for cursor-anchored zoom.
    mutating func zoom(by factor: CGFloat, around anchor: CGPoint) {
        let before = toWorld(anchor)
        zoom = (zoom * factor).clamped(0.1, 4.0)
        let after = toWorld(anchor)
        pan.x += before.x - after.x
        pan.y += before.y - after.y
    }
}
```

---

## 2. Rendering strategy: three approaches

There is no single right answer; pick by node count and interactivity needs.

| Approach | Good for | Hit-testing | Per-node SwiftUI views (text fields, hover, Liquid Glass) | Ceiling |
|---|---|---|---|---|
| **Layered SwiftUI views** (`ForEach` of node views in a `ZStack`, transformed) | Rich interactive nodes, < ~300–500 visible | Free (SwiftUI gestures per node) | Yes | Layout cost explodes with count |
| **`Canvas` (immediate-mode draw)** | Thousands of nodes/edges, mostly visual | Manual (hit-test in world space) | No (you draw primitives) | Very high (GPU via internal rasterization) |
| **Hybrid** (recommended): `Canvas`/drawn layer for edges + culled `ForEach` for visible interactive nodes | The brainstorming board case | Hybrid | Yes, for visible nodes only | High |

### 2a. Layered views + a single transform

Apply **one** transform to a container, not per-node. Prefer `scaleEffect` + `offset` on the
container holding world-positioned children. Place each node with `.position()` in world
coords; the container transform handles camera.

```swift
ZStack {
    EdgesLayer(model: model)                 // Canvas-based, see §6
    ForEach(model.visibleNodes) { node in    // §5 culling
        NodeView(node: node)
            .position(node.position)         // WORLD coordinates
    }
}
.scaleEffect(viewport.zoom, anchor: .topLeading)
.offset(x: -viewport.pan.x * viewport.zoom,
        y: -viewport.pan.y * viewport.zoom)
.frame(maxWidth: .infinity, maxHeight: .infinity)
.contentShape(Rectangle())                   // make empty canvas hittable for pan/marquee
```

Pitfalls:
- `scaleEffect` scales *rasterized* content — text gets blurry when zoomed in past ~2x unless
  you re-render at the new scale. For crisp text, multiply font size / re-layout at high zoom,
  or accept blur for distant zoom. `Canvas` text avoids this (drawn at current scale).
- Don't nest a `scaleEffect` per node; one container transform keeps the layout tree cheap.
- `drawingGroup()` on the container flattens to one Metal-backed layer — big win for many
  *static* shapes, but it **disables interactive subviews and live text editing** inside.
  Use it only on the non-interactive edge/decoration layer, not the interactive node layer.

### 2b. `Canvas` for the heavy layer

`Canvas { ctx, size in ... }` is immediate-mode, GPU-rasterized, and handles thousands of
primitives at 60fps where a `ForEach` of `Circle()` collapses to ~12fps at 500 nodes. Draw in
screen space by applying the viewport transform yourself, or push a `CGAffineTransform`:

```swift
Canvas { ctx, size in
    ctx.transform = CGAffineTransform(translationX: -viewport.pan.x * viewport.zoom,
                                      y: -viewport.pan.y * viewport.zoom)
        .scaledBy(x: viewport.zoom, y: viewport.zoom)
    for edge in model.visibleEdges {           // cull first (§5)
        var path = Path()
        path.move(to: edge.from)
        path.addCurve(to: edge.to, control1: edge.c1, control2: edge.c2)
        ctx.stroke(path, with: .color(.secondary), lineWidth: 1.5 / viewport.zoom)
    }
    // ctx.draw(Text("…"), at: …) for labels; resolve symbols once outside the loop if reused
}
.drawingGroup()   // optional; benchmark — can help or hurt
```

`Canvas` is `Sendable`-closure based and re-runs on any state change it captures, so feed it a
*culled, pre-computed* array, not your whole model. **[verify]** `AsyncCanvas` / off-main-thread
canvas rendering has circulated in community posts; treat it as experimental and benchmark
before relying on it.

---

## 3. Gestures: pan & zoom

### Pinch zoom (trackpad / Magic Mouse)

Use `MagnifyGesture` (the renamed `MagnificationGesture`; `MagnifyGesture` is current). Its
`value.magnification` starts at 1.0; multiply, don't add. Critically, use
`value.startAnchor` / the gesture location to zoom around the cursor:

```swift
@GestureState private var pinch: CGFloat = 1.0

MagnifyGesture()
    .updating($pinch) { v, state, _ in state = v.magnification }
    .onChanged { v in
        // anchor-correct zoom; convert startAnchor (UnitPoint) to screen point
    }
    .onEnded { v in viewport.zoom(by: v.magnification, around: lastCursor) }
```

### Drag to pan

`DragGesture(minimumDistance:)`. Convert *screen* translation to world by dividing by zoom.
**Gesture ordering matters**: on macOS, attach drag *before* magnify (or compose with
`.simultaneously(with:)`) — otherwise drag `onChanged` may not fire when both are present.

```swift
DragGesture()
    .onChanged { v in
        viewport.pan.x = panStart.x - v.translation.width / viewport.zoom
        viewport.pan.y = panStart.y - v.translation.height / viewport.zoom
    }
    .onEnded { _ in panStart = viewport.pan }
```

### Scroll-wheel & two-finger trackpad scroll (macOS) — the part SwiftUI doesn't give you

SwiftUI has no first-class scroll-wheel hook for a custom canvas. Bridge `NSEvent` via an
`NSViewRepresentable` whose view overrides `scrollWheel(with:)`. Mac convention:
**two-finger scroll = pan**, **pinch or ⌘+scroll = zoom**. Distinguish trackpad from a mouse
wheel with `event.hasPreciseScrollingDeltas`.

```swift
final class CanvasEventView: NSView {
    var onScroll: ((CGSize, _ precise: Bool) -> Void)?
    var onZoom:   ((CGFloat, NSPoint) -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override func viewDidMoveToWindow() { window?.makeFirstResponder(self) }

    override func scrollWheel(with e: NSEvent) {
        if e.modifierFlags.contains(.command) {           // ⌘+scroll → zoom
            let factor = 1 + e.scrollingDeltaY * 0.01
            onZoom?(factor, convert(e.locationInWindow, from: nil))
        } else {                                          // pan
            onScroll?(CGSize(width: e.scrollingDeltaX, height: e.scrollingDeltaY),
                      e.hasPreciseScrollingDeltas)
        }
    }
    // Optionally override magnify(with:) for the hardware pinch gesture too.
}
```

`magnify(with:)` on `NSView` gives the raw trackpad pinch (`event.magnification`) if you want
to bypass SwiftUI's `MagnifyGesture` for tighter control. Keep the AppKit view as a transparent
overlay/background so SwiftUI node views still receive clicks.

---

## 4. The `ScrollView` + `.scrollClipDisabled` / zoom alternative

If your scene is *bounded-ish* you can lean on AppKit-backed scrolling instead of a manual
camera. There is **no native SwiftUI `zoomable` modifier**; the common patterns are:

- Wrap an `NSScrollView` (which has real `magnification`, `minMagnification`,
  `maxMagnification`, `magnify(toFit:)`, momentum, and overlay scrollers) in an
  `NSViewRepresentable` and host SwiftUI via `NSHostingView`. This is the most "Mac-native"
  zoom/pan and is what to reach for if you want system momentum and scrollbars for free.
- Pure-SwiftUI `ScrollView` gained richer control in recent releases (`scrollPosition(_:)`,
  `onScrollGeometryChange`, `onScrollPhaseChange`) but it does **not** zoom and is not truly
  infinite, so it's a weak fit for this app's hero feature.

For a genuinely *infinite* canvas the manual `Viewport` (§1) wins: `NSScrollView` needs a
finite `documentView` frame, so you'd have to grow/recenter it, which fights the agent-driven
unbounded layout. **Recommendation: manual camera for the canvas; reserve `ScrollView` for
side panels.**

---

## 5. Viewport culling (the real performance lever)

Don't render what's off-screen. Compute the visible world rect each frame and filter:

```swift
extension CanvasModel {
    func visibleRect(viewSize: CGSize, viewport: Viewport) -> CGRect {
        let origin = viewport.pan
        let size = CGSize(width: viewSize.width / viewport.zoom,
                          height: viewSize.height / viewport.zoom)
        return CGRect(origin: origin, size: size).insetBy(dx: -margin, dy: -margin)
    }
}
```

- Filter nodes/edges to `visibleRect` before handing them to `ForEach`/`Canvas`.
- For large scenes (10k+ nodes) back the model with a **spatial index** (uniform grid or
  quadtree) so culling is O(visible) not O(total). A simple grid keyed by
  `(x/cell, y/cell)` is usually enough and trivial to keep updated on agent mutations.
- **Level of detail (LOD):** below some zoom, draw nodes as plain rects/dots and skip text and
  Liquid Glass; only render full `NodeView` chrome when zoomed in. This keeps far-out
  "overview" frames cheap.
- Throttle: coalesce rapid agent mutations into a single per-frame model snapshot
  (see §8) so culling/layout runs once per frame, not once per mutation.

---

## 6. Edges / connections between nodes

Edges live in world space as `(fromNodeID, toNodeID)` plus optional routing metadata. Resolve
to points at draw time so they follow nodes the agent moves. Draw them in the **`Canvas` layer
below the nodes** (one path batch is far cheaper than N `Path` views).

```swift
func edgePath(from a: CGPoint, to b: CGPoint) -> Path {
    var p = Path()
    p.move(to: a)
    let dx = (b.x - a.x) * 0.5                 // horizontal "S" bezier, like node editors
    p.addCurve(to: b,
               control1: CGPoint(x: a.x + dx, y: a.y),
               control2: CGPoint(x: b.x - dx, y: b.y))
    return p
}
```

Notes:
- Use `CGPath`/`Path`, **not `UIBezierPath`** (UIKit-only, unavailable on macOS).
- Style with `StrokeStyle(lineWidth: 1.5 / zoom, lineCap: .round, lineJoin: .round)` so line
  weight stays visually constant across zoom.
- Anchor edges to node *ports* (computed from node frame edges) rather than centers for a
  cleaner look; recompute ports from the (world-space) node rect.
- Arrowheads / labels: draw with `ctx.fill` for the triangle and `ctx.draw(resolvedText, at:)`.
  Resolve reused symbols once outside the loop.

---

## 7. Hit-testing & selection

Two regimes, matching §2:

- **Interactive node views** (layered approach): SwiftUI handles hit-testing for free —
  attach `.onTapGesture`, `.gesture`, hover, context menus directly to `NodeView`. Selection is
  just an `id` (or `Set<ID>`) in the store.
- **`Canvas`-drawn nodes**: you hit-test manually. Convert the click to world space
  (`viewport.toWorld(clickPoint)`), then query your spatial index for the topmost node whose
  world rect contains it. `Canvas` also supports `.onTapGesture { location in … }` and you can
  tag drawn regions with `ctx.drawLayer` but you still own the point-in-shape math.

Marquee/rubber-band selection: a `DragGesture` on the empty canvas (enabled by
`.contentShape(Rectangle())`), build a world-space rect from start→current, select intersecting
nodes. Hold ⇧ to add to selection. Keep the marquee rect in screen space for drawing, world
space for the intersection test.

---

## 8. State store the external agent mutates — live updates

This is the architectural crux. The agent (separate process/thread, or an async task driving an
LLM tool loop) must mutate canvas state and have the view reflect it without manual refreshing.

### Use `@Observable` (Observation framework), not `ObservableObject`

`@Observable` (macOS 14+) tracks property access at the granularity of *fields actually read by
a view*, so an agent moving one node only invalidates views that read that node — far less churn
than `@Published`/`objectWillChange` broadcasting to everything.

```swift
@Observable
final class CanvasStore {
    var nodes: [Node.ID: Node] = [:]
    var edges: [Edge] = []
    var viewport = Viewport()
    var selection: Set<Node.ID> = []

    // Mutations the agent calls (must run on @MainActor — see below)
    func upsert(_ node: Node) { nodes[node.id] = node }
    func move(_ id: Node.ID, to p: CGPoint) { nodes[id]?.position = p }
    func connect(_ a: Node.ID, _ b: Node.ID) { edges.append(.init(from: a, to: b)) }
}
```

```swift
struct CanvasView: View {
    @State private var store = CanvasStore()   // or inject via @Environment
    var body: some View { /* §2 render reads store.nodes etc. */ }
}
```

### Threading & live-ness rules

- **All mutations that touch `@Observable` state must land on `@MainActor`.** Mark the store
  `@MainActor` (or hop with `await MainActor.run`/`Task { @MainActor in }`). SwiftUI observes
  on the main actor; mutating from a background thread is a data race and updates may not be
  delivered.
- The agent should do its thinking/network off-main, then apply a **mutation** on main. Model
  mutations as small commands (`MoveNode`, `AddEdge`, `SetText`) so they're easy to apply,
  batch, undo, and serialize over a wire if the agent is out-of-process.
- **Coalesce bursts:** if the agent streams many edits, buffer them and flush once per frame
  (e.g. via a `CADisplayLink`/`DisplayLink` equivalent or an `AsyncStream` you drain on a timer)
  so SwiftUI re-renders once, not per edit. This is what keeps "live" feeling smooth.
- **Animate agent edits:** wrap applied mutations in `withAnimation` so nodes glide to new
  positions / fade in, making the AI's changes legible. Use `.matchedGeometryEffect` or
  `.animation(_, value:)` keyed on node identity.

### Out-of-process agent

If the writer is a separate process, expose the store through an `AsyncStream<Mutation>`
(XPC / local socket / file watch) drained by a `@MainActor` task that applies each mutation.
The SwiftUI view never knows the difference — it just observes the store.

---

## 9. Persistence / serialization

Because positions live in world space, the model is trivially serializable and is exactly what
the external writer should read/write. Keep the on-disk format **agent-friendly** (stable IDs,
flat structure, mergeable):

```swift
struct Node: Identifiable, Codable, Hashable {
    let id: UUID
    var position: CGPoint        // world space
    var size: CGSize
    var title: String
    var body: String
    var color: String?           // semantic, not a raw NSColor
}
struct Edge: Identifiable, Codable, Hashable {
    let id: UUID
    var from: Node.ID
    var to: Node.ID
}
struct CanvasDocument: Codable {
    var nodes: [Node]
    var edges: [Edge]
    var viewport: Viewport       // camera persisted so the board reopens where you left it
    var schemaVersion: Int = 1
}
```

Options, in rough order of fit:
- **Plain `Codable` → JSON** in a `FileDocument`/`ReferenceFileDocument` (or
  `DocumentGroup`). Simplest; human- and agent-diffable; great for a file the agent edits.
- **SwiftData** (`@Model`) if you want querying, relationships, and undo for free, and the
  agent runs in-process. Note SwiftData mutations also flow through `@Observable`-style
  tracking, so live updates work the same way; just keep writes on the main context's actor.
- **CRDT / op-log** if multiple writers (user + agent) edit concurrently and you need conflict
  resolution. Overkill unless you have true concurrency; the command/mutation log in §8 is a
  lightweight stepping stone (and gives you undo/redo).

Always include a `schemaVersion` so the agent and app can negotiate format changes.

---

## 10. Liquid Glass on canvas chrome (macOS 26)

Liquid Glass belongs to the **functional layer** (toolbars, floating inspectors, the zoom HUD,
context menus) — **never the content layer** (the canvas itself or the nodes' fills). Putting
glass on nodes *and* on a toolbar over them creates muddy glass-on-glass sampling. The canvas
is content; keep it opaque/material-free and reserve glass for floating controls.

Core APIs (WWDC25, macOS 26):

```swift
// A floating zoom/HUD control over the canvas — functional layer.
HStack {
    Button("–") { store.viewport.zoom(by: 0.8, around: center) }
    Text("\(Int(store.viewport.zoom * 100))%")
    Button("+") { store.viewport.zoom(by: 1.25, around: center) }
}
.padding(8)
.glassEffect(.regular.interactive(), in: .capsule)   // glassEffect(_:in:isEnabled:)
```

Rules to avoid glass-on-glass:
- **Group sibling glass controls in one `GlassEffectContainer(spacing:)`** so they sample the
  *background*, not each other, and merge/morph cleanly. Glass cannot correctly sample other
  glass.

```swift
@Namespace private var glassNS
GlassEffectContainer(spacing: 12) {
    ForEach(tools) { tool in
        ToolButton(tool)
            .glassEffect(.regular.interactive())
            .glassEffectID(tool.id, in: glassNS)   // smooth morph between states
    }
}
```

- Don't stack a glass node inside a glass panel inside a glass toolbar. One glass surface per
  visual stratum.
- `.tint(_:)` only on the primary action (semantic meaning), not for decoration.
- Let the canvas content (nodes/edges) be solid so the glass chrome has real content to refract.
- `scrollEdgeEffect` (new in 26) gives toolbar/edge fades for `ScrollView`-based side panels;
  the manual canvas won't use it. **[verify]** exact `scrollEdgeEffect` style names against SDK.

Accessibility: glass auto-adapts to Reduce Transparency / Increase Contrast — don't hardcode
opacities that fight it.

---

## 11. Recommended architecture (summary)

1. **One `@Observable @MainActor CanvasStore`** holding `nodes`/`edges` in **world space** plus a
   `Viewport` camera. This is the single source of truth the external agent mutates.
2. **Manual camera transform** (not `NSScrollView`, not SwiftUI `ScrollView`) for true infinity:
   one `scaleEffect`+`offset` container; cursor-anchored zoom math in `Viewport`.
3. **Hybrid rendering:** a `Canvas` layer for edges and far-zoom/LOD node glyphs +
   a **viewport-culled** `ForEach` of interactive `NodeView`s for what's on screen. Back culling
   with a grid/quadtree spatial index for 10k+ nodes.
4. **Gestures:** `MagnifyGesture` + `DragGesture` for SwiftUI, plus an `NSViewRepresentable`
   bridging `scrollWheel(with:)`/`magnify(with:)` for native two-finger pan and ⌘-scroll zoom.
5. **Agent path:** agent thinks off-main, applies small `Mutation` commands on `@MainActor`,
   coalesced once per frame and wrapped in `withAnimation`; observation makes the view update
   live with no manual refresh. Persist as versioned `Codable` JSON (or SwiftData in-process).
6. **Liquid Glass only on floating chrome**, grouped in `GlassEffectContainer`; canvas stays
   content-layer opaque.

---

## Sources

- Apple — Canvas: https://developer.apple.com/documentation/swiftui/canvas
- Apple — MagnifyGesture: https://developer.apple.com/documentation/swiftui/magnifygesture
- Apple — ScrollView: https://developer.apple.com/documentation/swiftui/scrollview
- Apple — NSHostingView scrollWheel(with:): https://developer.apple.com/documentation/swiftui/nshostingview/scrollwheel(with:)
- Apple — glassEffect(_:in:): https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)
- Apple — Applying Liquid Glass to custom views: https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views
- Apple — Drawing paths and shapes (tutorial): https://developer.apple.com/tutorials/swiftui/drawing-paths-and-shapes
- Apple Developer Forums — SwiftUI macOS scroll wheel events: https://developer.apple.com/forums/thread/742868
- Apple Developer Forums — Multiplatform macOS panning: https://developer.apple.com/forums/thread/731530
- Apple Developer Forums — Simultaneous drag and magnification: https://developer.apple.com/forums/thread/133398
- Hacking with Swift — drawingGroup()/Metal: https://www.hackingwithswift.com/books/ios-swiftui/enabling-high-performance-metal-rendering-with-drawinggroup
- Hacking with Swift — pinch to zoom: https://www.hackingwithswift.com/quick-start/swiftui/how-to-handle-pinch-to-zoom-for-views
- Hacking with Swift — UIBezierPath/CGPath in SwiftUI: https://www.hackingwithswift.com/quick-start/swiftui/how-to-use-uibezierpath-and-cgpath-in-swiftui
- Hacking with Swift forums — Infinite scrollable Canvas on macOS: https://www.hackingwithswift.com/forums/swiftui/infinite-scrollable-canvas-on-macos/17609
- Swift with Majid — Mastering Canvas in SwiftUI: https://swiftwithmajid.com/2023/04/11/mastering-canvas-in-swiftui/
- Medium (Ravi) — SwiftUI Canvas performance 2025: https://ravi6997.medium.com/swiftuis-canvas-revolution-how-apple-s-new-drawing-api-is-transforming-ios-development-in-2025-ac0c1eb838df
- Medium (Mr. Hotfix) — Canvas + Metal custom renderers: https://medium.com/@mrhotfix/advanced-swiftui-rendering-canvas-particle-effects-and-metal-shaders-1cd9fe6d79d9
- Medium (Andrei Durymanov) — AsyncCanvas in SwiftUI [verify]: https://medium.com/@adurymanov/asynccanvas-in-swiftui-a80deea7f1b9
- Medium (Gaurav Harkhani) — Reusable zoomable & pannable view: https://medium.com/@gauravharkhani01/building-a-reusable-zoomable-and-pannable-view-in-swiftui-7f17f41e23c9
- fatbobman — Evolution of SwiftUI scroll control APIs: https://fatbobman.com/en/posts/the-evolution-of-swiftui-scroll-control-apis/
- Atelier Socle — SwiftUI Liquid Glass complete guide (iOS 26): https://www.atelier-socle.com/en/articles/swiftui-liquid-glass-guide
- DEV — Liquid Glass official best practices (iOS 26 / macOS Tahoe): https://dev.to/diskcleankit/liquid-glass-in-swift-official-best-practices-for-ios-26-macos-tahoe-1coo
- Blake Crosley — Liquid Glass SwiftUI patterns: https://blakecrosley.com/blog/liquid-glass-swiftui-patterns
- conorluddy — Liquid Glass Reference: https://github.com/conorluddy/LiquidGlassReference
- ExploreSwiftUI — WWDC25 iOS 26 SwiftUI features: https://exploreswiftui.com/wwdc25
- WWDCNotes — What's new in SwiftUI (WWDC25, session 256): https://wwdcnotes.com/documentation/wwdcnotes/wwdc25-256-whats-new-in-swiftui/
