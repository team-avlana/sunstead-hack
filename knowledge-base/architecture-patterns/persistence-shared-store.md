# Persistence: A Shared Store for Swift + Python

_Last updated: 2026-06-24_

A persistence layer for Rainy (native SwiftUI, macOS 27) that is readable AND writable by BOTH the Swift app and the bundled Python sidecar. Data includes app data and a "canvas".

## TL;DR / Recommendation

**Use plain SQLite — GRDB on Swift, `sqlite3`/SQLModel(SQLAlchemy) on Python — in WAL mode, with a busy timeout on every connection, Swift-owned GRDB migrations, and a lightweight cross-process notification side-channel so the app re-queries after the sidecar writes.** Do **not** point Python at a SwiftData or Core Data store.

## 1. Choosing the store: SwiftData vs Core Data vs plain SQLite

Deciding question: *can a non-Swift process safely read AND write the same file?*

### SwiftData — NO (risky, unsupported)
SwiftData persists to SQLite (on macOS, `default.store` + `-wal`/`-shm`) and shares Core Data's storage format. That on-disk schema is **private and undocumented** — Apple documents the API, not the table/column layout — and changes between OS releases. Writing from Python means reverse-engineering an unsupported schema and replicating Core Data bookkeeping; a wrong write corrupts the store and breaks migrations. **Avoid.**

### Core Data — NO (same problem, explicit)
The Core Data SQLite store carries metadata tables with no corresponding entities:
- **`Z_METADATA`** — version, store UUID, `Z_PLIST` BLOB describing the model.
- **`Z_PRIMARYKEY`** — Core Data allocates PKs itself (reads last-used `Z_MAX`, increments, writes back). An external writer that inserts without updating `Z_PRIMARYKEY` collides PKs and corrupts the store.
- Entity tables are `Z…`-prefixed with system columns `Z_PK`, `Z_ENT`, `Z_OPT`.

Apple explicitly disclaims safety for external modification ("real risk of data inconsistency, which could corrupt the database"). **Avoid for an external writer.**

### Plain SQLite — YES (the interoperable choice)
SQLite's file format is public, stable, cross-language; you own the schema, no hidden bookkeeping. Swift: **GRDB** (WAL, migrations, observation, multi-process guidance). Python: stdlib **`sqlite3`**, or **SQLModel/SQLAlchemy**. This is also where the ecosystem is heading for this need (e.g. Point-Free's GRDB-backed `sqlite-data`, a SwiftData alternative).

**Recommendation: plain SQLite. GRDB (Swift) + `sqlite3`/SQLModel (Python).**

## 2. Concurrency & locking with two processes on one file

- **Why WAL is required.** Default rollback journal blocks readers vs writers. **WAL allows multiple concurrent readers + one writer** — the writer appends to `-wal`, readers keep snapshot end-marks. WAL keeps the UI process readable while the sidecar writes.
- **Single-writer limitation.** One `-wal` file → exactly one writer at a time across all processes; a second writer gets `SQLITE_BUSY`. You serialize writes via the busy timeout.
- **Cross-process coordination** is via the memory-mapped `-shm` wal-index → all processes **must be on the same host** (no network filesystem). Fine here; don't put the DB on a share.
- **WAL is persistent** — set `PRAGMA journal_mode=WAL` once (Swift app, first launch/migration); Python inherits it.
- **Checkpointing** folds WAL back into the main `.db`. A reader that never closes its transaction can pin the WAL and prevent truncation → **keep read transactions short** on both sides.

### `busy_timeout` — the single most important setting
Without it, a contended write fails *instantly* with `database is locked`; with it, the connection waits and retries. **Set ≥ 5000 ms.** It is **per-connection** — set on **every** connection in **both** processes.

### Avoid the read-then-upgrade deadlock
A connection holding a read lock that tries to upgrade to a write while another process is writing gets `SQLITE_BUSY` immediately — `busy_timeout` can't help. Fix: start write transactions with **`BEGIN IMMEDIATE`** (take the write lock up front). **GRDB 7 does this automatically** (DEFERRED reads / IMMEDIATE writes). On Python you must do it yourself (§6).

### Best-practice PRAGMAs (both processes)
```
PRAGMA journal_mode = WAL;       -- concurrent readers + 1 writer; persistent
PRAGMA busy_timeout = 5000;      -- per connection!
PRAGMA synchronous = NORMAL;     -- safe + fast under WAL
PRAGMA foreign_keys = ON;        -- per connection
```

## 3. Schema sharing / single source of truth

- **The Swift app owns migrations** (primary, always present, runs first). Use **GRDB `DatabaseMigrator`** — records applied migrations in `grdb_migrations`, applies pending idempotently at startup.
- **Python is a schema *consumer*, not a migrator.** Do not let SQLModel/SQLAlchemy `create_all()` or Alembic run against this DB — that creates a competing source of truth and races the Swift migrator. Python **reflects** existing tables (or uses hand-written models that mirror them) and only `INSERT/UPDATE/SELECT`.
- **Version guard:** keep `PRAGMA user_version` (or an `app_meta(schema_version)` row) bumped by the Swift migrator. On startup the sidecar reads it and refuses/warns if the schema is newer than it knows — prevents writing against an unknown schema after an app update.
- **Startup ordering:** launch the sidecar *after* the app has opened the pool and run migrations.

```swift
var migrator = DatabaseMigrator()
// migrator.eraseDatabaseOnSchemaChange = true   // DEV ONLY
migrator.registerMigration("v1") { db in
    try db.create(table: "canvasNode") { t in
        t.primaryKey("id", .text)            // UUID string — language-neutral
        t.column("kind", .text).notNull()
        t.column("x", .double).notNull()
        t.column("y", .double).notNull()
        t.column("payload", .blob)           // JSON/canvas blob
        t.column("updatedAt", .datetime).notNull()
    }
    try db.execute(sql: "PRAGMA user_version = 1")
}
try migrator.migrate(dbPool)
```

Keep columns to SQLite primitives (TEXT/INTEGER/REAL/BLOB); use **string UUID** PKs so both sides generate IDs without coordinating a counter.

## 4. Observing EXTERNAL writes — the critical gotcha

**Most people get this wrong.** GRDB's `ValueObservation`/Combine publishers are built on SQLite update/commit hooks, which fire **only for writes through GRDB's own connections inside this process**. They do **not** see writes from another process. GRDB states this explicitly: *"GRDB Database Observation does not detect changes performed by external processes,"* and advises considering plain files or other IPC before sharing a SQLite database.

So the Swift app **will not auto-refresh** when the Python sidecar writes. You must add a trigger:

| Approach | Verdict |
|---|---|
| SQLite update hooks | **Don't** — in-process only; the root of the problem. |
| Polling | Works always; wastes CPU, adds latency. OK fallback. |
| File-watch on `-wal` | Cheap; noisy (every checkpoint), no info on *what* changed. Decent fallback. |
| **Notification side-channel** | **Best** — precise, low-latency, drives a targeted re-fetch. |

### Recommended: write through SQLite, *notify* out-of-band, re-fetch via GRDB
The sidecar commits to SQLite, then signals the app. The app re-runs a normal GRDB read (reads always see the latest committed data — only the *observation* was missing). Good signal channels: the **stdout pipe** you already own (a line like `changed:canvasNode` — simplest, can carry which table changed; see realtime-app-ipc.md), **Darwin notifications** (`notify_post` via `ctypes`, payload-free), or a `change_log` table polled only when nudged.

```swift
import GRDB

// Local observation (sees this process's own writes):
let observation = ValueObservation.tracking { db in
    try CanvasNode.order(Column("updatedAt")).fetchAll(db)
}
let cancellable = observation.start(in: dbPool,
    onError: { error in /* log */ },
    onChange: { nodes in self.nodes = nodes })

// External nudge from the sidecar -> re-query manually:
func handleSidecarChangeNotification() {
    Task {
        let fresh = try await dbPool.read { db in
            try CanvasNode.order(Column("updatedAt")).fetchAll(db)
        }
        await MainActor.run { self.nodes = fresh }
    }
}
```

```swift
import GRDB
var config = Configuration()
config.busyMode = .timeout(5)                       // matches Python
config.prepareDatabase { db in
    try db.execute(sql: "PRAGMA synchronous = NORMAL")
    try db.execute(sql: "PRAGMA foreign_keys = ON")
}
// DatabasePool opens in WAL automatically. GRDB 7 auto-manages txn kinds.
let dbPool = try DatabasePool(path: dbURL.path, configuration: config)
```

> Use `DatabasePool` (opens WAL automatically), **not** `DatabaseQueue`, for a shared concurrent DB.

## 5. Migration & keeping the canvas model consistent
- One migrator, in Swift (§3); Python never alters schema; bump `user_version` per migration.
- **Language-neutral canvas model:** primitive columns + a `payload BLOB` (JSON) both sides read/write identically. No `NSKeyedArchiver`, no Core Data transformables in shared columns.
- **String UUID PKs** so both processes mint IDs independently.
- **`updatedAt`** (ISO-8601 TEXT or epoch INTEGER) on every row — powers "rows changed since T" re-fetch and conflict resolution.
- **Conflict policy:** WAL = no torn writes, but two processes can target the same row over time. Pick a rule — last-writer-wins by `updatedAt`, or partition ownership (app owns app-data tables, sidecar owns its output tables, canvas shared with LWW).
- **Keep write transactions tiny** (ideally one statement) on both sides to minimize lock-hold time.

## 6. Python sidecar connection setup

### Stdlib `sqlite3`
```python
import sqlite3

def open_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None, timeout=5.0)  # control txns explicitly
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")   # per-connection, MUST set
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def write_node(conn, node_id, kind, x, y, payload):
    conn.execute("BEGIN IMMEDIATE")              # write lock up front -> no upgrade deadlock
    try:
        conn.execute(
            "INSERT INTO canvasNode(id,kind,x,y,payload,updatedAt) "
            "VALUES(?,?,?,?,?,datetime('now')) "
            "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, x=excluded.x, "
            "y=excluded.y, payload=excluded.payload, updatedAt=excluded.updatedAt",
            (node_id, kind, x, y, payload))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK"); raise
    notify_app_changed("canvasNode")             # cross-process nudge (stdout line / Darwin notify)
```

### SQLModel / SQLAlchemy
```python
from sqlalchemy import create_engine, event
engine = create_engine("sqlite:///app.db", connect_args={"timeout": 5})

@event.listens_for(engine, "connect")
def _pragmas(dbapi_conn, _rec):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()

@event.listens_for(engine, "begin")
def _begin_immediate(conn):                       # force IMMEDIATE for write txns
    conn.exec_driver_sql("BEGIN IMMEDIATE")
```
Use models that **mirror** the Swift-owned schema; do not run `create_all()`/Alembic against this DB.

## Recommendation (justified)
Plain SQLite, GRDB + `sqlite3`/SQLModel, WAL, 5s busy timeout on every connection, Swift-owned migrations, notification side-channel for cross-process observation. Because: (1) only plain SQLite is a documented, stable, cross-language format — SwiftData/Core Data carry private metadata and Apple disclaims external-write safety; (2) WAL is exactly the multi-reader/one-writer, same-host concurrency model needed; (3) GRDB gives WAL pools, migrations, observation, and auto-manages transaction kinds (GRDB 7); (4) GRDB *cannot* observe the other process's writes — a documented hard limit — so a notification side-channel + manual re-fetch is required, not optional.

## Flagged uncertain / version-sensitive items
- **GRDB 7 transaction behavior** confirmed from the GRDB 7 migration guide, but verify the exact `Configuration` API (`busyMode`, `prepareDatabase`) against your pinned version — these surfaces shifted 5→6→7.
- GRDB's "Sharing a Database" page is iOS-centric (App Groups, suspension); much doesn't apply to a macOS app+sidecar. Re-read for your version before copying.
- **macOS 27:** no version-specific SQLite/GRDB behavior surfaced. If you need a specific SQLite build, bundle GRDB's custom SQLite rather than relying on the system `libsqlite3` across both processes.
- **Darwin-notification from Python** needs `notify_post` via `ctypes` or a small native helper; signing/entitlements can affect delivery. A plain stdout pipe between parent app and child sidecar is the most portable fallback.

## Sources
- https://sqlite.org/wal.html
- https://www.sqlite.org/pragma.html
- https://databaseschool.com/articles/sqlite-recommended-pragmas
- https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view
- https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/
- https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/
- https://swiftpackageindex.com/groue/GRDB.swift/documentation/grdb/databasesharing
- https://groue.github.io/GRDB.swift/docs/5.14/Structs/ValueObservation.html
- https://github.com/groue/GRDB.swift/blob/master/Documentation/GRDB7MigrationGuide.md
- https://fatbobman.com/en/posts/key-considerations-before-using-swiftdata/
- https://fatbobman.com/en/posts/tables_and_fields_of_coredata/
- https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CoreData/PersistentStoreFeatures.html
- https://techblog.lycorp.co.jp/en/exploring-best-practices-for-core-data-from-the-sqlite-perspective
- https://www.pointfree.co/blog/posts/168-sharinggrdb-a-swiftdata-alternative
- https://til.simonwillison.net/sqlite/enabling-wal-mode
- https://charlesleifer.com/blog/going-fast-with-sqlite-and-python/
- https://dev.to/lumin-playstar/sqlite-wal-mode-10x-performance-for-python-apps-4ic
