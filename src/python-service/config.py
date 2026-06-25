import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

# Load credentials from a local .env (DB_CONNECTION_STRING, AZURE_ANTHROPIC_URL,
# AZURE_ANTHROPIC_KEY) before settings are read. Resolved relative to this file so
# it works regardless of the process CWD. python-dotenv is optional.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass


@dataclass
class DbConfig:
    connection_string: str = "postgresql://user:pass@localhost:5432/sunstead"


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 9000


@dataclass
class WorkerConfig:
    python: str = "python"
    entrypoint: str = "../analysis-worker/main.py"
    max_channel_videos: int = 5


@dataclass
class LlmConfig:
    azure_anthropic_url: str = ""
    azure_anthropic_key: str = ""


@dataclass
class TerminalConfig:
    """The Claude Code CLI hosted in a PTY for the canvas's right-side panel.

    `command` is the argv spawned in the pseudo-terminal (never user-controlled).
    `cwd` is the working directory claude opens in (default: the user's home).
    """

    enabled: bool = True
    command: list[str] = field(default_factory=lambda: ["claude"])
    cwd: str = ""


@dataclass
class Settings:
    db: DbConfig = field(default_factory=DbConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    llm: LlmConfig = field(default_factory=LlmConfig)
    terminal: TerminalConfig = field(default_factory=TerminalConfig)


def load() -> Settings:
    path = os.environ.get("APP_CONFIG", "./config.toml")
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except FileNotFoundError:
        raw = {}

    db_raw = raw.get("db", {})
    srv_raw = raw.get("server", {})
    wkr_raw = raw.get("worker", {})
    llm_raw = raw.get("llm", {})
    term_raw = raw.get("terminal", {})

    # Env vars override config.toml for credentials
    conn_str = (
        os.environ.get("DB_CONNECTION_STRING")
        or db_raw.get("connection_string", DbConfig.connection_string)
    )
    azure_url = (
        os.environ.get("AZURE_ANTHROPIC_URL")
        or llm_raw.get("azure_anthropic_url", "")
    )
    azure_key = (
        os.environ.get("AZURE_ANTHROPIC_KEY")
        or llm_raw.get("azure_anthropic_key", "")
    )

    return Settings(
        db=DbConfig(connection_string=conn_str),
        server=ServerConfig(
            host=srv_raw.get("host", ServerConfig.host),
            port=srv_raw.get("port", ServerConfig.port),
        ),
        worker=WorkerConfig(
            python=wkr_raw.get("python", WorkerConfig.python),
            entrypoint=wkr_raw.get("entrypoint", WorkerConfig.entrypoint),
            max_channel_videos=wkr_raw.get("max_channel_videos", WorkerConfig.max_channel_videos),
        ),
        llm=LlmConfig(azure_anthropic_url=azure_url, azure_anthropic_key=azure_key),
        terminal=TerminalConfig(
            enabled=str(os.environ.get("RAINY_TERMINAL_ENABLED", term_raw.get("enabled", True))).lower()
            not in ("0", "false", "no"),
            command=(
                os.environ["RAINY_CLAUDE_COMMAND"].split()
                if os.environ.get("RAINY_CLAUDE_COMMAND")
                else term_raw.get("command", ["claude"])
            ),
            cwd=os.environ.get("RAINY_CLAUDE_CWD") or term_raw.get("cwd", ""),
        ),
    )


settings = load()
