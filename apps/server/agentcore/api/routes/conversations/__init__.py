"""Conversation routes, split by domain into one aggregated ``APIRouter``.

This package was split out of a single ``conversations.py`` along domain seams
(file-splitting.mdc): CRUD, messages, interactions, local-mode binding, local→云
handoff, turn re-execution/resume, workspace snapshots, and workspace files.

The sub-routers are included in the original file's definition order, so the
generated OpenAPI spec (path + method order, operationIds, tags) stays
byte-identical to the pre-split build — and ``main.py``'s
``app.include_router(conversations.router, prefix="/v1")`` keeps working unchanged.
``_preflight_turn_llm`` is re-exported because an integration test imports it
directly from this module.
"""

from fastapi import APIRouter

from . import (
    audit,
    binding,
    crud,
    files,
    handoff,
    interactions,
    messages,
    run_redirect,
    snapshots,
    turns,
)
from ._helpers import TurnPreflightResult, _preflight_turn_llm

# Each domain sub-router carries the original ``prefix="/conversations",
# tags=["conversations"]`` so this aggregate stays a plain concatenator.
router = APIRouter()

# Included in the original file's definition order so the OpenAPI path/method order
# stays byte-identical (the spec is the single source for the generated TS types).
router.include_router(crud.router)
router.include_router(messages.router)
router.include_router(audit.router)
router.include_router(interactions.router)
router.include_router(run_redirect.router)
router.include_router(binding.router)
router.include_router(handoff.router)
router.include_router(turns.router)
router.include_router(snapshots.router)
router.include_router(files.router)

__all__ = ["router", "_preflight_turn_llm", "TurnPreflightResult"]
