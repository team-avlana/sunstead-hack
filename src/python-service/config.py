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


MAX_CHANNEL_VIDEOS = 20


@dataclass
class WorkerConfig:
    python: str = "python"
    analyzer_entrypoint: str = "../analysis-worker/main.py"
    profile_entrypoint: str = "../analysis-worker/build_profile.py"
    max_channel_videos: int = 5


@dataclass
class LlmConfig:
    anthropic_api_key: str = ""
    azure_anthropic_url: str = ""
    azure_anthropic_key: str = ""
    elevenlabs_api_key: str = ""


@dataclass
class ImageConfig:
    azure_openai_url: str = ""        # e.g. https://<resource>.openai.azure.com
    azure_openai_key: str = ""
    azure_openai_deployment: str = "gpt-image-1.5"       # creator room
    azure_openai_storyboard_deployment: str = "gpt-image-1-mini"  # storyboard frames


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
    image: ImageConfig = field(default_factory=ImageConfig)
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
    img_raw = raw.get("image", {})
    term_raw = raw.get("terminal", {})

    # Env vars override config.toml for credentials
    conn_str = os.environ.get("DB_CONNECTION_STRING") or db_raw.get(
        "connection_string", DbConfig.connection_string
    )
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or llm_raw.get(
        "anthropic_api_key", ""
    )
    azure_url = os.environ.get("AZURE_ANTHROPIC_URL") or llm_raw.get(
        "azure_anthropic_url", ""
    )
    azure_key = os.environ.get("AZURE_ANTHROPIC_KEY") or llm_raw.get(
        "azure_anthropic_key", ""
    )
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY") or llm_raw.get(
        "elevenlabs_api_key", ""
    )

    openai_url = os.environ.get("AZURE_OPENAI_URL") or img_raw.get(
        "azure_openai_url", ""
    )
    openai_key = os.environ.get("AZURE_OPENAI_KEY") or img_raw.get(
        "azure_openai_key", ""
    )
    openai_deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT") or img_raw.get(
        "azure_openai_deployment", ImageConfig.azure_openai_deployment
    )
    openai_storyboard_deployment = os.environ.get("AZURE_OPENAI_STORYBOARD_DEPLOYMENT") or img_raw.get(
        "azure_openai_storyboard_deployment", ImageConfig.azure_openai_storyboard_deployment
    )

    return Settings(
        db=DbConfig(connection_string=conn_str),
        server=ServerConfig(
            host=srv_raw.get("host", ServerConfig.host),
            port=srv_raw.get("port", ServerConfig.port),
        ),
        worker=WorkerConfig(
            python=wkr_raw.get("python", WorkerConfig.python),
            analyzer_entrypoint=wkr_raw.get(
                "analyzer_entrypoint", WorkerConfig.analyzer_entrypoint
            ),
            profile_entrypoint=wkr_raw.get(
                "profile_entrypoint", WorkerConfig.profile_entrypoint
            ),
            max_channel_videos=min(
                wkr_raw.get("max_channel_videos", WorkerConfig.max_channel_videos),
                MAX_CHANNEL_VIDEOS,
            ),
        ),
        llm=LlmConfig(
            anthropic_api_key=anthropic_key,
            azure_anthropic_url=azure_url,
            azure_anthropic_key=azure_key,
            elevenlabs_api_key=elevenlabs_key,
        ),
        image=ImageConfig(
            azure_openai_url=openai_url,
            azure_openai_key=openai_key,
            azure_openai_deployment=openai_deployment,
            azure_openai_storyboard_deployment=openai_storyboard_deployment,
        ),
        terminal=TerminalConfig(
            enabled=str(
                os.environ.get("RAINY_TERMINAL_ENABLED", term_raw.get("enabled", True))
            ).lower()
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
