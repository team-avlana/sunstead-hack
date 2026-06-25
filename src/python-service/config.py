import os
import sys
from dataclasses import dataclass, field

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


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
    analyzer_entrypoint: str = "../analysis-worker/main.py"
    profile_entrypoint: str = "../analysis-worker/build_profile.py"
    max_channel_videos: int = 5


@dataclass
class LlmConfig:
    anthropic_api_key: str = ""
    azure_anthropic_url: str = ""
    azure_anthropic_key: str = ""


@dataclass
class Settings:
    db: DbConfig = field(default_factory=DbConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    llm: LlmConfig = field(default_factory=LlmConfig)


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
            max_channel_videos=wkr_raw.get(
                "max_channel_videos", WorkerConfig.max_channel_videos
            ),
        ),
        llm=LlmConfig(
            anthropic_api_key=anthropic_key,
            azure_anthropic_url=azure_url,
            azure_anthropic_key=azure_key,
        ),
    )


settings = load()
