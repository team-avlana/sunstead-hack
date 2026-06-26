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
class AgentConfig:
    """Our own assistant, built on the Claude Agent SDK and hosted by this service
    (the default right-panel experience — see canvas-ui/components/AgentPanel.tsx).

    Unlike the Claude Code PTY path (which runs under the user's own login), the
    agent authenticates with a COMPANY-OWNED credential read from the process env,
    so end users never supply Claude credentials. Provider routing for the Agent
    SDK is global env config read at engine startup, NOT a per-call base_url:

      - `base_url` → exported as ANTHROPIC_BASE_URL. Point this at an Anthropic-
        compatible endpoint (e.g. the Azure Foundry endpoint — the same one the
        analysis-worker uses via AnthropicFoundry) to bill agent inference through
        Azure. Leave empty for the direct Anthropic API.
      - `api_key`  → exported as ANTHROPIC_API_KEY (falls back to the Azure / direct
        Anthropic key already configured under [llm]).

    AZURE FOUNDRY (verified working): the Agent SDK / Claude Code engine does NOT
    ride Azure via a plain ANTHROPIC_BASE_URL — that makes it send first-party-only
    beta headers Azure rejects (400). Instead it has a dedicated Foundry mode keyed
    off `foundry_resource`: when set, agent_bridge exports CLAUDE_CODE_USE_FOUNDRY=1
    + ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY (and leaves the
    first-party vars unset). The resource is the first label of the Azure host
    (e.g. `avlana-gpt-sweden-resource` from `avlana-gpt-sweden-resource.services.ai.azure.com`).
    Only models actually deployed in that resource work (here: sonnet / haiku, not
    opus). With no Foundry resource we fall back to direct Anthropic via base_url +
    api_key (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY).
    """

    enabled: bool = True
    model: str = "claude-sonnet-4-6"
    base_url: str = ""
    api_key: str = ""
    # Azure Foundry resource name; when set the agent uses Foundry mode (above).
    foundry_resource: str = ""


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
class DevConfig:
    """Development-only observability. When `logs` is on (env RAINY_DEV_LOGS), the
    service runs an in-memory activity/timing event bus and exposes /dev/events so
    the canvas-ui can render the Service Activity panel. Off by default — never
    enable in a shared/exposed deployment (it streams internal logs + timings)."""

    logs: bool = False


@dataclass
class Settings:
    db: DbConfig = field(default_factory=DbConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    llm: LlmConfig = field(default_factory=LlmConfig)
    image: ImageConfig = field(default_factory=ImageConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    terminal: TerminalConfig = field(default_factory=TerminalConfig)
    dev: DevConfig = field(default_factory=DevConfig)


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
    agent_raw = raw.get("agent", {})
    term_raw = raw.get("terminal", {})
    dev_raw = raw.get("dev", {})

    dev_logs = str(
        os.environ.get("RAINY_DEV_LOGS", dev_raw.get("logs", False))
    ).lower() in ("1", "true", "yes", "on")

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

    # The agent's provider defaults to the same credentials the rest of the service
    # already has: an explicit ANTHROPIC_BASE_URL, else the Azure Foundry endpoint;
    # the key falls back to the direct-Anthropic key, then the Azure key.
    agent_model = os.environ.get("RAINY_AGENT_MODEL") or agent_raw.get(
        "model", AgentConfig.model
    )
    agent_base_url = (
        os.environ.get("ANTHROPIC_BASE_URL")
        or agent_raw.get("base_url", "")
        or azure_url
    )
    agent_api_key = (
        os.environ.get("ANTHROPIC_API_KEY")
        or agent_raw.get("api_key", "")
        or anthropic_key
        or azure_key
    )
    # Azure Foundry resource: explicit env/config, else derived from the Azure host's
    # first label (avlana-gpt-sweden-resource.services.ai.azure.com → the label).
    agent_foundry_resource = (
        os.environ.get("ANTHROPIC_FOUNDRY_RESOURCE")
        or agent_raw.get("foundry_resource", "")
    )
    if not agent_foundry_resource and azure_url:
        from urllib.parse import urlparse

        host = urlparse(azure_url).hostname or ""
        if host.endswith(".services.ai.azure.com"):
            agent_foundry_resource = host.split(".")[0]
    agent_enabled = str(
        os.environ.get("RAINY_AGENT_ENABLED", agent_raw.get("enabled", True))
    ).lower() not in ("0", "false", "no")

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
        agent=AgentConfig(
            enabled=agent_enabled,
            model=agent_model,
            base_url=agent_base_url,
            api_key=agent_api_key,
            foundry_resource=agent_foundry_resource,
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
        dev=DevConfig(logs=dev_logs),
    )


settings = load()
