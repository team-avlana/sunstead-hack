# Live-Collaboration & Op-Model Architecture for an Agent-Driven Canvas

_Last updated: 2026-06-24_

How real-time multiplayer canvas tools represent and sync edits, and how to map those ideas to
**Rainy's actual problem, which is much simpler**: ONE local user editing an infinite canvas while
ONE AI agent (Claude Code over MCP, or a fast local router model) edits it concurrently, against an
authoritative local **SQLite (WAL)** store.

This builds on, and does not repeat, `canvas/infinite-canvas-swiftui.md` (world-space model,
`@Observable @MainActor CanvasStore`, hybrid render, per-frame coalescing, `withAnimation`) and the
decisions in `docs/DECISIONS.md` (R1/R2/R4, D14 two-sidecar topology). Read that doc first; this one
answers a different question: **what is the edit-representation and conflict model?**

> TL;DR recommendation (details in §7): **No CRDT. No OT.** Use an **authoritative SQLite store +
> a small typed op-log**, with **per-record / per-property last-write-wins** exactly like Figma and
> tldraw, plus **fractional indexing for ordering**. Treat the agent as a second writer whose ops
> are applied to the same store and **animated**, but gate destructive/large moves behind a
> **suggestion ("ghost") layer the user accepts/rejects**. The user always wins live drags via a
> short-lived **soft lock** on the node being dragged.

---

## 0. The crucial framing: Rainy is NOT multiplayer

Almost everything written about Figma/tldraw/Liveblocks/Yjs is solving **N-user, networked,
high-latency, partition-tolerant** collaboration. Rainy has:

- **2 logical writers** (user + agent), not N.
- **Both on the same machine**, sub-millisecond "network." No partitions, no offline merge, no
  geo-distribution. The SQLite file is *the* central authority.
- **Asymmetric writers.** The user is a fast, interactive, authoritative human; the agent is a
  slower, burst-y, *correctable* process whose mistakes should be cheap to undo.
- **No conflict storm.** The realistic concurrency is "user is dragging node X while the agent, a
  beat behind, also touches X (or deletes it)." That's a handful of contended records, not thousands.

This collapses the design space enormously. CRDTs exist to reach *eventual consistency without a
central authority*. Rainy **has** a central authority (the SQLite file + the `@MainActor` store).
Per Figma's own reasoning, that authority lets you "remove the extra overhead" of CRDTs and ship a
"faster and leaner implementation." We adopt that conclusion directly.

---

## 1. How the real tools represent & sync edits

Four distinct strategies show up in production. Summary, then specifics.

| Tool | Sync model | Conflict granularity | Conflict resolution | CRDT? |
|---|---|---|---|---|
| **Figma** | Centralized LWW registers | Per **(object, property)** | Last value the *server* received wins (server defines order, **no timestamps**) | "CRDT-inspired", not real CRDT |
| **tldraw / tldraw sync** | Record store + `RecordsDiff` patches over WebSocket to a Durable Object | Per **record** (shape/binding) | Per-record LWW, server-ordered; ephemeral keys (presence) separated | No (centralized) |
| **Excalidraw** | Broadcast scene elements, reconcile | Per **element** | `version` (higher wins) → tie-break `versionNonce` (higher wins) → `updated` ts | No |
| **Liveblocks Storage** | CRDT-*inspired* `LiveObject`/`LiveMap`/`LiveList` over their server | Per property (Object/Map) / per item (List) | Object/Map = LWW (last received by server); List = fractional-index CRDT merge | "Inspired by CRDTs" |
| **Yjs** (for reference) | True CRDT (YATA) | Per character / per item | Real CRDT merge, no central authority needed | **Yes** (used by Liveblocks *only* for text) |

### 1a. Figma — last-writer-wins registers (the model Rainy should copy)

- Document = `Map<ObjectID, Map<Property, Value>>` — a tree, like the DOM, where the parent link is
  itself a property on the child.
- The server keeps "the latest value any client sent for a given property on a given object." Two
  clients editing **different properties of the same object don't conflict**; two clients editing the
  **same property of different objects don't conflict.** Only same-property-same-object conflicts, and
  there "the document just ends up with the last value sent to the server."
- **No timestamps needed** — the server defines the order of events. (LWW register where the "clock"
  is server arrival order.)
- **Atomic at the property-value boundary**: the converged value is always *some value a client
  actually sent*, never a synthesized blend. (Contrast Excalidraw, which tie-breaks numerically.)
- **Creation** = a LWW boolean "exists" property (LWW set). **Deletion** does NOT keep the deleted
  object's properties on the server — they live in the *deleting client's undo buffer*; undoing a
  delete makes that client responsible for restoring all properties. This keeps long-lived docs from
  growing unbounded.
- **IDs are client-generated** and embed the client ID for global uniqueness without a round trip.
- **Sibling order = fractional indexing** (see §4). Parent-link + position are stored as **one
  property** so they update atomically (prevents an object briefly belonging to two parents).
- **Text is the known exception**: editing the same text property doesn't merge — "AB" vs "BC"
  yields AB or BC, never ABC. Figma accepts this because it's a design tool, not a text editor.
- **They explicitly rejected OT** ("unnecessarily complex," proofs "error-prone even for two
  characterwise primitives") **and pure CRDTs** ("unavoidable performance and memory overhead" you
  don't need with a central server).

### 1b. tldraw — a reactive record store + diffs (the closest architectural twin)

- `@tldraw/store` (`TLStore`) holds **records** (`TLShape`, `TLBinding`, …). `@tldraw/state` provides
  the reactive (signals) layer. This is structurally what `infinite-canvas-swiftui.md` calls the
  `@Observable CanvasStore`.
- Changes are expressed as a **`RecordsDiff`**: `{ added, updated: {id: [before, after]}, removed }`,
  keyed by record ID. `store.applyDiff(diff)` applies it; this is the wire and history unit.
- **History/undo** uses *marks* and squashing: `squashToMark` collapses all changes since a mark into
  a single undo step. The timeline-scrubber example shows diffs being collected, squashed into one
  optimized diff, then applied (reversing for backward). This is exactly the **op-log + coalescing**
  pattern Rainy wants.
- **Ephemeral keys** (presence, hover, current tool) are flagged so they don't pollute history or
  persistence — a distinction Rainy needs too (cursor/selection vs. real edits).
- **tldraw sync** (their networked layer) = hub-and-spoke: one **Cloudflare Durable Object per room**,
  WebSockets, **~30 collaborators/room**. Persistence moved to **SQLite inside the Durable Object**
  (added behind a flag **Dec 2025**, made default **Feb 2026** — confirmed via tldraw GitHub issue
  #8560 / DeepWiki). Conflict resolution is per-record, server-ordered. Rainy does not need any of the
  networking — but the *record-store + diff* shape and the SQLite authority are directly reusable.

### 1c. Excalidraw — version + versionNonce reconciliation

- Each element carries `version` (int, incremented per change), `versionNonce` (random, regenerated
  per change), and `updated` (epoch ms).
- `Collab._reconcileElements()`: **higher `version` wins**; if equal, **higher `versionNonce` wins**;
  `updated` is the final tie-break. Restores/repairs elements (bindings, legacy migration) before
  reconciling. This is LWW-with-a-deterministic-tiebreak; the random nonce guarantees every peer
  converges to the *same* winner even with identical versions.
- Useful for Rainy as a **fallback tiebreak** when both writers bump the same record in the same tick
  and you want determinism without trusting wall-clock time.

### 1d. Liveblocks — CRDT-inspired structures; Yjs only for text

- `LiveObject`/`LiveMap` = **LWW** (last update received by the server wins) — same as Figma.
- `LiveList` = a **fractional-index CRDT**: concurrent inserts/moves converge without a canonical
  integer index. Liveblocks calls out fractional indexing as "how Figma and Linear order realtime
  lists."
- For **collaborative text**, Liveblocks delegates to **Yjs** (a real CRDT). The pattern — *LWW for
  structure/geometry, real CRDT only for free-text* — is the right mental split. Rainy's node titles
  are short; whether you even need character-level text CRDT is questionable (see §5).

---

## 2. What Rainy actually needs (and doesn't)

| Multiplayer concern | Needed for Rainy? | Why |
|---|---|---|
| Eventual consistency w/o central authority (CRDT) | **No** | SQLite file + `@MainActor` store *is* the authority. |
| Operational transform | **No** | Same authority; Figma/tldraw both rejected it. |
| Per-(record,property) LWW | **Yes** | Cheap, correct for geometry/metadata; the proven default. |
| Server-defined / single-writer ordering | **Yes (trivially)** | The `@MainActor` apply loop *is* the serialization point. |
| Fractional indexing for z-order / list order | **Yes** | Avoids reindex churn when agent reorders; agent picks a key "between" without touching siblings. |
| Presence/cursor sync, 30-user rooms, Durable Objects | **No** | One machine, two writers. |
| Character-level text CRDT (Yjs) | **Probably not** | Node titles are short; node-level LWW + don't-clobber-while-typing (§5) suffices. Revisit only if you add long collaborative rich-text nodes. |
| Op-log / command stream | **Yes** | Drives animation, undo/redo, and the agent's "suggestion" review. The hero "feels alive" property comes from *replaying ops with `withAnimation`*. |

---

## 3. The OP / COMMAND model (the heart of "feels alive")

Represent every canvas change — from the user *and* from the agent — as a **small, typed,
serializable op**. This is the unit that the agent emits, the app applies + animates, the undo stack
stores, and (optionally) the op-log persists. It mirrors tldraw's `RecordsDiff` and the agent
starter-kit's Zod "action" schemas.

### 3a. Op vocabulary (keep it tiny and total)

```swift
enum CanvasOp: Codable, Sendable {
    case addNode(Node)                              // create
    case removeNode(id: Node.ID, tombstone: NodeSnapshot)  // keep snapshot for undo (Figma-style)
    case setPosition(id: Node.ID, to: CGPoint)      // move  (the hot path)
    case setSize(id: Node.ID, to: CGSize)
    case setText(id: Node.ID, field: TextField, to: String)
    case setOrder(id: Node.ID, fracIndex: String)   // z-order via fractional index (§4)
    case setColor(id: Node.ID, to: String?)
    case addEdge(Edge)
    case removeEdge(id: Edge.ID, tombstone: Edge)
    case setEdgeLabel(id: Edge.ID, to: String)
    case batch([CanvasOp])                           // atomic group => one undo step
}
```

Each op also carries envelope metadata (not shown in the enum, attach at apply time):

```swift
struct OpEnvelope: Codable, Sendable {
    let op: CanvasOp
    let origin: Origin          // .user | .agent(modelID) | .system
    let lamport: UInt64         // monotonic counter assigned at the @MainActor apply point
    let txnID: UUID             // groups a batch / a single agent "thought" for undo
    let ephemeral: Bool         // selection/hover/cursor => never persisted, never undoable
}
```

`lamport` is just a monotonic `UInt64` incremented on the main actor. Because **all applies are
serialized through `@MainActor`**, this counter *is* Figma's "server-defined order" — you get global
ordering for free, no wall clock, no nonce required. (Keep Excalidraw's nonce idea in your back
pocket only if you ever apply ops off-main.)

### 3b. Apply path (single funnel — do NOT let the agent mutate the store directly)

Everything — user gestures, agent MCP calls, undo/redo — funnels through ONE reducer on the main
actor. This is the most important structural rule.

```swift
@MainActor
final class CanvasStore {           // @Observable, world-space (see infinite-canvas-swiftui.md)
    private var lamport: UInt64 = 0
    private(set) var history = OpLog()           // for undo/redo + persistence debounce

    func apply(_ op: CanvasOp, origin: Origin, animated: Bool, txn: UUID = UUID()) {
        lamport += 1
        let env = OpEnvelope(op: op, origin: origin, lamport: lamport, txnID: txn,
                             ephemeral: op.isEphemeral)

        // (1) conflict gate — §6 (locks / suggestion routing) runs BEFORE mutation
        guard conflictGate(env) == .apply else { return }   // .drop / .deferToSuggestion handled inside

        // (2) mutate the @Observable state
        let inverse = mutate(op)                 // returns the inverse op for undo

        // (3) record for undo + persistence (skip ephemeral)
        if !env.ephemeral { history.record(env, inverse: inverse, animated: animated) }
    }

    private func mutate(_ op: CanvasOp) -> CanvasOp { /* switch over op; returns inverse */ }
}
```

### 3c. Coalescing & ordering (the "live but smooth" lever)

The agent will stream many `setPosition` ops while laying out (think "arrange these 12 outliers in a
grid"). Two things keep it smooth, both already foreshadowed in `infinite-canvas-swiftui.md` §5/§8:

1. **Per-frame coalescing.** Buffer incoming ops in an `AsyncStream` and drain once per frame
   (`CADisplayLink`/`DisplayLink`). Collapse runs of `setPosition(id:)` for the **same id** to the
   **last** value (LWW *within the frame*) — only the final position matters per frame. This is
   exactly tldraw's "squash diffs into one optimized diff."
2. **Stable ordering.** Drain in `lamport` order; ties broken by arrival. Because the drain is on
   `@MainActor`, the user's in-flight drag ops and the agent's ops interleave deterministically.

```swift
// agent ops arrive off-main via MCP stdout notifications (DECISIONS R1) → AsyncStream
let coalesced = rawOps
    .collectPerFrame()                      // your DisplayLink-driven buffer
    .map { frameOps in dedupeLastWriteWins(frameOps) }   // per (id, kind) keep last
for frameBatch in coalesced {
    withAnimation(.snappy(duration: 0.18)) {            // make agent edits legible
        frameBatch.forEach { store.apply($0.op, origin: .agent(model), animated: true) }
    }
}
```

**Animate agent edits, apply user edits instantly.** A node the *agent* moves should glide
(`withAnimation`, ~150–200ms) so the change reads as "the AI did this." A node the *user* drags must
track the cursor with **no** animation (animating a live drag feels broken). Branch on `origin`.

### 3d. Undo / redo WITH an agent in the loop

Two-stack undo, but with the multiplayer-undo refinement from Figma and the replicated-register
literature: **the undo stack contains only ops the *local actor* generated**, and undo edits redo
history at undo time. Concretely for Rainy:

- **One unified history is wrong** if the user expects ⌘Z to undo *their* action, not the agent's
  last autonomous layout. Recommended: a single ordered op-log for persistence/animation, but undo
  **scoped by origin with a default of "user's last txn"** plus an explicit "Undo AI change" affordance
  for agent txns. The agent's multi-op layout is one `txnID` → one undo step (tldraw's `squashToMark`).
- **Tombstones for delete-undo** (Figma's trick): `removeNode` carries a `NodeSnapshot` so undo can
  restore *all* properties, and so the server/store doesn't have to retain dead rows. The snapshot
  lives in the op-log entry, not as a live SQLite row.
- **Clearing redo:** when the user performs a fresh op, clear *their* redo stack — but an agent op
  arriving shouldn't silently nuke the user's redo. Keep redo scoped per-origin or, simpler, snapshot
  redo into the txn so "undo a lot, copy, redo to present" leaves the doc unchanged (Figma's
  invariant).

---

## 4. Ordering & layout: fractional indexing

For z-order (and any agent "arrange in this sequence" op), store an **order key as a string fractional
index**, not an integer. Inserting/moving a node sets *only that node's* key to a value "between" its
neighbors — siblings are never touched, so the agent reordering 1 of 200 nodes emits **1 op, not 200**.

- Figma: position is "a fraction between 0 and 1 exclusive"; insert = average of neighbors.
- Liveblocks/Linear: same idea, **base-96 encoded** strings (e.g. `a0`, `a1`, `a0V`) so keys stay
  short instead of `0.5 → 0.25 → 0.125…` decimal blowup.
- Concurrency edge case: if user and agent both insert "between A and B" and pick the same key, append
  a per-origin disambiguator (Liveblocks appends a unique id: `0.75-user`, `0.75-agent`). With Rainy's
  single `@MainActor` funnel this is rare, but keep the tiebreak for determinism.

Use a tiny `fractionalIndexBetween(a: String?, b: String?) -> String` helper (port of the well-known
`fractional-indexing` algorithm, or the `jordanbtucker/fractional-indexing` reference). Store the key
as `CanvasNode.z` (the schema already has a `z` column in `docs/DATA_MODEL.md` — make it TEXT, not a
float, to hold the fractional key).

---

## 5. Text: do you need a CRDT for node titles?

No, almost certainly. Figma itself does **not** merge concurrent same-text edits (you get one side's
value, never an interleaved blend) and considers that acceptable for a non-text-editor. Rainy's nodes
are short titles/bodies. Recommended:

- **Node-level LWW on `setText`** like every other property.
- **Don't clobber a field the user is actively typing in:** while a `NodeView` text field has focus,
  the conflict gate (§6) **routes agent `setText` for that field into the suggestion layer** instead of
  overwriting the cursor. This is the text analog of the drag soft-lock.
- Only adopt **Yjs (or a Swift CRDT) for a single node type** if you later add long-form,
  simultaneously-edited rich-text notes — and even then, scope the CRDT to that field, exactly as
  Liveblocks scopes Yjs to text while keeping geometry on LWW.

---

## 6. Conflict handling: user drags a node the agent is also moving/deleting

This is the *only* real conflict Rainy has, and it deserves a deliberate, opinionated policy. Three
mechanisms, used together:

### 6a. Soft lock — user-in-progress wins (the live-drag case)

When the user begins dragging node X (or editing its text), mark it `interacting` (an **ephemeral**
flag — never persisted, never in history). The conflict gate then:

- **Agent `setPosition`/`setSize` on a soft-locked node → dropped** (or buffered as a suggestion).
  Rationale: animating the agent fighting the user's cursor is the worst possible feel. The human's
  direct manipulation is authoritative *for the duration of the gesture*.
- On gesture end, release the lock. The agent's *next* op applies normally. If the agent had a pending
  intent for that node, surface it as a ghost (§6c) rather than silently snapping the node away.

This is a 1-bit-per-contended-node mechanism, not real locking infrastructure. It's the local analog of
Figma "applying local changes immediately and discarding conflicting server updates for unacknowledged
local edits."

### 6b. Delete vs. drag — the dangerous one

Agent `removeNode(X)` while the user is dragging X:

- **Defer the delete** until the gesture ends (queue it), OR
- **Convert it to a suggestion** (ghost the node as "AI wants to remove this" with an Undo/keep
  affordance). Never yank a node out from under an active drag — it strands the gesture and feels like
  a crash.

Because deletes carry a tombstone snapshot (§3d), a deferred/rejected delete is trivially reversible.

### 6c. Suggestion / "ghost" layer — agent edits as proposals (recommended default for *destructive & large* edits)

The strongest pattern from current agent-canvas products (Intercom Fin "propose → user approves",
tldraw agent streaming with user still in control, the "AI architecture builder" draw-then-confirm
flows): **the agent edits the live store for cheap/additive things, but routes risky edits through a
review layer.**

Tier agent ops by blast radius:

| Op class | Examples | Default handling |
|---|---|---|
| **Additive / cheap** | `addNode`, `addEdge`, `setColor`, small `setPosition` of agent-created nodes | **Apply live + animate.** Low regret; this is most of "feels alive." |
| **Mutating user content** | `setPosition`/`setSize` of a *user-created* node, `setText` on a focused field | **Apply live but easily-undoable**, OR ghost if soft-locked. |
| **Destructive / bulk** | `removeNode`, `removeEdge`, mass re-layout of the user's nodes | **Ghost / suggest** → user accepts (⌘↵) or rejects (⌫). |

Ghost rendering = the same `NodeView`, drawn at reduced opacity / dashed outline / "AI" badge, backed
by a *parallel pending-op set* not yet committed to the store. Accepting replays the pending ops
through `apply(origin: .agent)`; rejecting discards them. This keeps the authoritative store clean and
gives the user a clear "the AI proposes, I dispose" mental model without blocking the additive
liveness that makes the feature magical.

Per-project setting: an **"autonomy slider"** (Suggest-only ↔ Auto-apply additive ↔ Full auto) lets
power users let the agent run free and cautious users keep a gate. Defaults: additive=auto,
destructive=suggest.

### 6d. Intent, not just position

When the agent moves many nodes, have it emit a `batch` with a human-readable *intent* string
("grouped by topic", "sorted by outlier score") attached to the `txnID`. The UI shows this as a
toast/inline label, and the single undo step is labeled "Undo: group by topic". This is cheap (it's
just metadata on the envelope) and massively improves legibility — the difference between "nodes
jumped" and "the AI grouped your nodes by topic, click to undo."

---

## 7. Recommended architecture for Rainy

**Authoritative SQLite store + typed op-log + per-record LWW + fractional indexing + suggestion layer.
No CRDT, no OT.**

### 7.1 Source of truth & writers

- **Truth = SQLite (WAL)** file (`docs/DECISIONS.md` R2). The in-memory `@Observable @MainActor
  CanvasStore` is the *live mirror* and the serialization point.
- **Two writers, one funnel.** The user's gestures and the agent's MCP ops both become `CanvasOp`s
  applied through the single `@MainActor apply()` reducer (§3b). The agent **never** writes the live
  store directly; it emits ops (additive ones apply live, risky ones become suggestions).
- **Two sidecar instances (D14).** App-spawned instance's stdout → `AsyncStream` → ops (R1). The
  Claude-Code-spawned instance writes SQLite and **notifies the app over the app-hosted local socket**
  to re-fetch / replay — same op pipeline, just a different transport in.

### 7.2 Edit representation

- **Per-(record, property) last-write-wins**, ordered by a `@MainActor` Lamport counter (Figma model,
  no timestamps). Keep Excalidraw's `versionNonce`-style tiebreak only as a guard if you ever apply
  off-main.
- **`CanvasOp` enum** (§3a) is the universal unit: agent emission, animation source, undo entry,
  optional persisted op-log row. Batches share a `txnID` = one undo step.
- **Fractional-index string** for `z`/order (§4); make `CanvasNode.z` TEXT.
- **Tombstone snapshots** on deletes for reversible undo without retaining dead rows.

### 7.3 Liveness & coalescing

- Agent ops → `AsyncStream` → **per-frame coalesce** (dedupe `setPosition` per id to last) → apply in
  `withAnimation` (~150–200ms). **User drags apply instantly, un-animated.**
- Persist on a **debounce** (e.g. flush op-log + upsert dirty records to SQLite every ~250–500ms or on
  txn boundary), not every op — keeps WAL writes off the hot path.

### 7.4 Conflict policy (§6, condensed)

1. **Soft lock** the node under an active user drag/edit → agent geometry/text ops on it are dropped or
   ghosted until release.
2. **Deletes/bulk re-layouts of user content → suggestion layer** (ghost, accept ⌘↵ / reject ⌫).
   Additive & agent-owned edits apply live.
3. **Intent metadata** on agent batches drives a legible, single-step, labeled undo.
4. **Autonomy slider** per project; default additive=auto, destructive=suggest.

### 7.5 Do you ever need a real CRDT?

Only if Rainy grows **multi-machine cloud sync** (OQ5 in DECISIONS) *or* **long collaborative
rich-text nodes**. Even then, follow Liveblocks: keep geometry/structure on LWW and scope a CRDT (Yjs
or a Swift port like `y-swift`/Automerge) to *just the text field*. For the current single-user +
one-agent local app, a CRDT is **net-negative** (memory, complexity, no benefit) — the authoritative
store already gives you convergence for free. This matches Figma's and tldraw's explicit conclusions.

### 7.6 Why this is enough (the one-line proof)

There is exactly **one serialization point** (the `@MainActor` apply loop). Every op passes through it
in a total order. A single total order over LWW registers is, by construction, strongly consistent —
that's precisely the property CRDTs work hard to *recover* in the absence of such a point. Rainy has the
point, so it gets the property for free.

---

## 8. Concrete build order (maps onto NEXT_STEPS)

1. `CanvasOp` enum + `OpEnvelope` + `@MainActor apply()` reducer returning inverses. (Foundation;
   everything else hangs off this.)
2. Wire **user gestures → ops** (drag emits `setPosition`, etc.) — proves the funnel before the agent.
3. **Op-log + two-stack undo/redo** with `txnID` grouping and tombstone snapshots.
4. **Per-frame coalescing** drain + `withAnimation` branch on `origin`.
5. **Fractional index** helper + TEXT `z` column.
6. Agent path: MCP-notification `AsyncStream` → ops (additive live). 
7. **Soft lock** + **suggestion/ghost layer** + autonomy slider + intent labels.
8. SQLite debounced persistence of records + (optional) op-log table for audit/replay.

---

## Sources

- Figma — How Figma's multiplayer technology works: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Figma — Making multiplayer more reliable: https://www.figma.com/blog/making-multiplayer-more-reliable/
- tldraw — sync docs: https://tldraw.dev/docs/sync
- tldraw — Store reference: https://tldraw.dev/reference/store/Store
- tldraw — RecordsDiff reference: https://tldraw.dev/reference/store/RecordsDiff
- tldraw — History (undo/redo): https://tldraw.dev/sdk-features/history
- tldraw — Timeline scrubber example (diff squashing): https://tldraw.dev/examples/timeline-scrubber
- tldraw — Agent starter kit: https://tldraw.dev/starter-kits/agent
- tldraw — AI integrations: https://tldraw.dev/docs/ai
- tldraw — agent-template prompt system (DeepWiki): https://deepwiki.com/tldraw/agent-template/4-prompt-system
- tldraw — Store and State Management (DeepWiki): https://deepwiki.com/tldraw/tldraw
- tldraw — sync SQLite persistence (GitHub issue #8560): https://github.com/tldraw/tldraw/issues/8560
- tldraw — sync on Cloudflare Durable Objects: https://github.com/tldraw/tldraw-sync-cloudflare
- tldraw — Announcing tldraw sync: https://tldraw.substack.com/p/announcing-tldraw-sync
- Excalidraw — Collaboration system (DeepWiki): https://deepwiki.com/excalidraw/excalidraw/7-collaboration-system
- Excalidraw — Scene serialization / version & versionNonce (DeepWiki): https://deepwiki.com/excalidraw/excalidraw/6.2-json-serialization
- Excalidraw — Collaboration concepts: https://excalidraw-excalidraw.mintlify.app/concepts/collaboration
- Liveblocks — Storage / sync engine: https://liveblocks.io/docs/collaboration-features/multiplayer/sync-engine/liveblocks-storage
- Liveblocks — Fractional indexing for realtime lists: https://liveblocks.io/blog/how-crdts-and-sync-engines-keep-realtime-lists-ordered-with-fractional-indexing
- Liveblocks — client API reference (LiveObject/LiveList/LiveMap): https://liveblocks.io/docs/api-reference/liveblocks-client
- Ably — Reliably syncing DB and frontend state (competitor analysis): https://ably.com/blog/database-sync-competitor-analysis
- arXiv — Undo and Redo Support for Replicated Registers: https://arxiv.org/pdf/2404.11308
- DEV — You Don't Know Undo/Redo: https://dev.to/isaachagoel/you-dont-know-undoredo-4hol
- jamespember — LLM flows on a multi-modal infinite canvas: https://jamespember.substack.com/p/llm-flows-on-a-multi-modal-infinite
