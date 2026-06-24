"""Shared SQLite access for the Rainy sidecar.

WAL mode + busy_timeout so this process and the Swift app (GRDB) can both write.
See ../docs/DATA_MODEL.md and
../knowledge-base/architecture-patterns/persistence-shared-store.md.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import uuid
from pathlib import Path


def default_db_path() -> Path:
    """Resolve the shared store path.

    The app passes RAINY_DB_PATH when it spawns the sidecar. Fall back to a
    dev location so the server is runnable standalone.
    """
    env = os.environ.get("RAINY_DB_PATH")
    if env:
        return Path(env)
    base = Path(
        os.environ.get(
            "RAINY_DATA_DIR",
            Path.home() / "Library" / "Application Support" / "Rainy",
        )
    )
    base.mkdir(parents=True, exist_ok=True)
    return base / "rainy.sqlite"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or default_db_path()
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Bootstrap the reference schema for standalone dev runs.

    In production the Swift app (GRDB migrations) owns the schema; this is a no-op
    if the tables already exist.
    """
    schema = Path(__file__).resolve().parent.parent / "schema.sql"
    if schema.exists():
        conn.executescript(schema.read_text())
    else:  # pragma: no cover - schema file should ship alongside the package
        print(f"[rainy-mcp] schema.sql not found at {schema}", file=sys.stderr)


def new_id() -> str:
    return uuid.uuid4().hex
