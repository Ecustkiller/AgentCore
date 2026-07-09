"""Structured logging configuration using structlog.

Rendering is dispatched per output target via ``ProcessorFormatter`` so each
handler picks its own renderer:

    输出目标        dev                         prod
    stdout         ConsoleRenderer(彩色可读)    JSONRenderer
    LOG_FILE       JSONRenderer (JSONL)         JSONRenderer (JSONL)

The file handler is ALWAYS JSON Lines (one JSON object per line, no ANSI),
regardless of env — that is what lets tooling/agents parse ``logs/dev.jsonl``
line-by-line (scripts/log_*.py, the conversation-logs rule). Foreign records
(uvicorn / sqlalchemy / …) flow through the same ``foreign_pre_chain`` so every
line — app or library — renders as a consistent event dict.

Correlation ids (trace_id / conversation_id / turn_id / …) are merged into
every line from ``structlog.contextvars`` (bound via ``core/log_context.py``).
"""

import logging
import sys
from pathlib import Path
from typing import cast

import structlog

from agentcore.config import PROJECT_ROOT, settings


def setup_logging() -> None:
    """Configure structlog + stdlib logging for the application.

    Reads ``settings.log_level`` / ``settings.log_file`` / ``settings.debug``.
    Idempotent: clears the root handlers first so a uvicorn ``--reload`` re-run
    does not stack duplicate handlers.
    """
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)

    # Applied to both structlog-origin and foreign (uvicorn / sqlalchemy) records,
    # so every handler renders a consistent event dict.
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    # 代码锚定 (code anchoring): stamp every APP log line with the emitting function + line
    # so a reader — or Cursor AI optimising the product AI from logs/dev.jsonl — can jump
    # straight from an event to its source. `logger` already carries the module (add_logger_name),
    # so func_name + lineno complete a `module.func:line` anchor (e.g. jump from
    # `delegate.started` to the exact emit site instead of grepping the event string).
    #
    # Deliberately NOT in `shared_processors` (which is also the foreign_pre_chain): uvicorn /
    # sqlalchemy records already carry their own stdlib callsite, and running this stack-walking
    # adder over them would both cost extra and anchor to logging-framework frames, not useful
    # code. Placed in the structlog-native chain, it captures the app frame in the emitting call.
    callsite = structlog.processors.CallsiteParameterAdder(
        {
            structlog.processors.CallsiteParameter.FUNC_NAME,
            structlog.processors.CallsiteParameter.LINENO,
        }
    )

    # Hand the event dict to stdlib logging; each handler picks its own renderer,
    # so stdout and the log file can be formatted differently.
    structlog.configure(
        processors=[
            *shared_processors,
            callsite,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    def _formatter(renderer: structlog.types.Processor) -> structlog.stdlib.ProcessorFormatter:
        return structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared_processors,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                renderer,
            ],
        )

    # stdout: human-readable in dev, JSON in prod.
    console_renderer: structlog.types.Processor = (
        structlog.dev.ConsoleRenderer(colors=True)
        if settings.debug
        else structlog.processors.JSONRenderer()
    )
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(_formatter(console_renderer))

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(log_level)
    root_logger.addHandler(stream_handler)

    # LOG_FILE is ALWAYS JSON Lines (no ANSI), regardless of env: this is what
    # lets tooling/agents parse logs/dev.jsonl line-by-line.
    if settings.log_file:
        log_path = Path(settings.log_file)
        if not log_path.is_absolute():
            log_path = PROJECT_ROOT / log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setFormatter(_formatter(structlog.processors.JSONRenderer()))
        root_logger.addHandler(file_handler)

    # Suppress noisy transport logs so the AI turn logs stay readable.
    noisy = [
        "uvicorn.access",
        "httpx",
        "httpcore",
        "httpcore.http11",
        "httpcore.connection",
        # The startup migration-drift check (db/migration_check.py) builds a
        # MigrationContext, which logs two INFO lines per boot; the actionable
        # signal is our own WARNING/ERROR, not alembic's transactional-DDL chatter.
        # (CLI `alembic upgrade` uses alembic.ini's own log config, untouched.)
        "alembic.runtime.migration",
    ]
    # Clamp the SQL engine logger ONLY when echo is off; when db_echo=True the
    # operator explicitly wants SQL statements, so suppressing would defeat the
    # switch (db/base.py wires echo=settings.db_echo).
    if not settings.db_echo:
        noisy += ["sqlalchemy.engine", "sqlalchemy.pool"]
    for name in noisy:
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Get a structlog logger instance.

    Always use this (not ``structlog.get_logger`` / ``logging.getLogger``) so a
    module's logs flow through the shared processor chain and carry the bound
    correlation context.
    """
    return cast(structlog.stdlib.BoundLogger, structlog.get_logger(name))
