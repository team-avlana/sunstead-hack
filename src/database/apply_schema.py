#!/usr/bin/env python3
"""Apply schema.sql to the configured Postgres database.

Usage:
    python apply_schema.py            # create the schema (fails if tables exist)
    python apply_schema.py --reset    # drop Rainy tables first, then recreate

Reads DB_CONNECTION_STRING from the environment, or from
../python-service/.env if python-dotenv is available.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / "schema.sql"

# Rainy tables in dependency order (children first) for a clean --reset.
RAINY_TABLES = ["artifacts", "memory", "shots", "style_profiles", "videos", "creators", "projects"]


def _load_env() -> str:
    try:
        from dotenv import load_dotenv

        load_dotenv(HERE.parent / "python-service" / ".env")
    except ImportError:
        pass
    dsn = os.environ.get("DB_CONNECTION_STRING", "")
    if not dsn:
        sys.exit("DB_CONNECTION_STRING is not set (env or python-service/.env)")
    return dsn


def split_statements(sql: str) -> list[str]:
    """Split a SQL script into statements, respecting $$ dollar-quoted bodies
    and -- line comments (a ';' inside a comment must not split a statement)."""
    statements: list[str] = []
    current: list[str] = []
    i, n, in_dollar = 0, len(sql), False
    while i < n:
        if not in_dollar and sql[i : i + 2] == "--":
            nl = sql.find("\n", i)
            if nl == -1:
                break
            i = nl  # drop the comment, keep the newline for the next iteration
            continue
        if sql[i : i + 2] == "$$":
            in_dollar = not in_dollar
            current.append("$$")
            i += 2
            continue
        ch = sql[i]
        if ch == ";" and not in_dollar:
            stmt = "".join(current).strip()
            if stmt:
                statements.append(stmt)
            current = []
        else:
            current.append(ch)
        i += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def main() -> None:
    dsn = _load_env()
    reset = "--reset" in sys.argv
    sql = SCHEMA.read_text()
    host = dsn.split("@")[-1].split("/")[0]
    print(f"Connecting to {host} …")

    with psycopg.connect(dsn, autocommit=False) as conn:
        with conn.cursor() as cur:
            if reset:
                print("--reset: dropping Rainy tables …")
                cur.execute(f"DROP TABLE IF EXISTS {', '.join(RAINY_TABLES)} CASCADE")
                cur.execute("DROP FUNCTION IF EXISTS touch_timestamps() CASCADE")
            for stmt in split_statements(sql):
                cur.execute(stmt)  # type: ignore[arg-type]
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name"
            )
            tables = [r[0] for r in cur.fetchall()]
    print(f"OK. Tables in public: {', '.join(tables)}")


if __name__ == "__main__":
    main()
