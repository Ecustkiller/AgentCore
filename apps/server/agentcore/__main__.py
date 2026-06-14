"""Console entry point for running the AgentCore API server.

Usage:
    uv run agentcore           # via the project script
    uv run python -m agentcore

Host / port / reload are read from Settings (.env) so that manual runs match
the VS Code auto-start task instead of hardcoding the same flags in two places.
"""

import uvicorn

from agentcore.config import settings


def main() -> None:
    uvicorn.run(
        "agentcore.main:app",
        host=settings.host,
        port=settings.port,
        # Hot-reload follows debug: dev (.env DEBUG=true) reloads, prod does not.
        reload=settings.debug,
    )


if __name__ == "__main__":
    main()
