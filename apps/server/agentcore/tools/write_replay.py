"""Flag: this tool execution is replaying an in-flight call after crash redrive.

``file_delete`` treats PathNotFound as already-applied success only in this
mode — a live model deleting a missing path is still a mistake.
"""

from __future__ import annotations

from contextvars import ContextVar, Token

current_write_replay: ContextVar[bool] = ContextVar("current_write_replay", default=False)


def begin_write_replay() -> Token[bool]:
    return current_write_replay.set(True)


def end_write_replay(token: Token[bool]) -> None:
    current_write_replay.reset(token)


def is_write_replay() -> bool:
    return bool(current_write_replay.get())
