"""Unit tests for per-conversation local binding resolution."""

import pytest

from agentcore.conversation.common import resolve_local_binding
from agentcore.db.models import Conversation


def _conv(**kwargs) -> Conversation:
    base = {"id": "11111111-1111-1111-1111-111111111111", "title": "t"}
    base.update(kwargs)
    return Conversation(**base)


@pytest.mark.asyncio
async def test_resolve_local_binding_prefers_explicit_root():
    conv = _conv(local_root_id="explicit", local_container_root_id="container")
    binding = await resolve_local_binding(None, conv)  # type: ignore[arg-type]
    assert binding is not None
    assert binding.root_id == "explicit"


@pytest.mark.asyncio
async def test_resolve_local_binding_falls_back_to_container_root():
    conv = _conv(local_root_id=None, local_container_root_id="container-abc", local_subpath="proj")
    binding = await resolve_local_binding(None, conv)  # type: ignore[arg-type]
    assert binding is not None
    assert binding.root_id == "container-abc"
    assert binding.subpath == "proj"


@pytest.mark.asyncio
async def test_resolve_local_binding_none_when_unbound():
    conv = _conv(local_root_id=None, local_container_root_id=None)
    assert await resolve_local_binding(None, conv) is None  # type: ignore[arg-type]
