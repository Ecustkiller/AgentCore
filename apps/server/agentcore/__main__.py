"""Console entry point for running the AgentCore API server.

Usage:
    uv run agentcore           # via the project script
    uv run python -m agentcore

Host / port / reload are read from Settings (.env) so that manual runs match the
VS Code auto-start task instead of hardcoding the same flags in two places.

Build provenance (GIT_SHA / BUILT_AT) is resolved here — before Settings is
imported — so a manual run and the systemd ExecStart share one stamping seam and
every uvicorn reload worker inherits the values (children inherit the parent
environment). The release pipeline may inject them via the environment, which
always takes precedence.
"""

from agentcore.buildinfo import resolve_build_provenance


def main() -> None:
    # Must precede the Settings import so the stamped values reach config and,
    # in reload mode, every worker process that re-reads the environment.
    resolve_build_provenance()

    import uvicorn

    from agentcore.config import settings

    uvicorn.run(
        "agentcore.main:app",
        host=settings.host,
        port=settings.port,
        # Hot-reload follows debug: dev (.env DEBUG=true) reloads, prod does not.
        reload=settings.debug,
    )


if __name__ == "__main__":
    main()
