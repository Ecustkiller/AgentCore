"""Last CEO chat header is reused by compaction; workers must not overwrite it."""

from types import SimpleNamespace

import pytest

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.observability.session_llm_header import (
    CHAT_HEADER_MODEL_USAGE_KEY,
    CHAT_HEADER_TOOLS_USAGE_KEY,
    FROZEN_CHAT_SYSTEM_USAGE_KEY,
    SessionLlmHeader,
    get_session_header,
    header_from_usage,
    header_to_usage,
    hydrate_session_header,
    pin_chat_system,
    pin_chat_tools,
    record_session_header,
    reset_session_headers,
)


def setup_function() -> None:
    reset_session_headers()


def teardown_function() -> None:
    reset_session_headers()


_TOOLS = [{"type": "function", "function": {"name": "delegate", "parameters": {}}}]


def test_records_chat_header_and_ignores_agent_title_compaction():
    cid = "conv-header-1"
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="deepseek-v4-pro",
        messages=[LLMMessage(role="system", content="CEO SYS")],
        tools=_TOOLS,
    )
    record_session_header(
        conversation_id=cid,
        scenario="agent",
        model="deepseek-v4-flash",
        messages=[LLMMessage(role="system", content="WORKER SYS")],
        tools=[{"type": "function", "function": {"name": "read", "parameters": {}}}],
    )
    record_session_header(
        conversation_id=cid,
        scenario="title",
        model="deepseek-v4-flash",
        messages=[LLMMessage(role="system", content="TITLE")],
        tools=None,
    )
    record_session_header(
        conversation_id=cid,
        scenario="compaction",
        model="deepseek-v4-flash",
        messages=[LLMMessage(role="system", content="FOLD")],
        tools=_TOOLS,
    )
    header = get_session_header(cid)
    assert header is not None
    assert header.system == "CEO SYS"
    assert header.model == "deepseek-v4-pro"
    assert header.tools[0]["function"]["name"] == "delegate"


def test_skips_non_system_first_message():
    record_session_header(
        conversation_id="conv-header-2",
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="user", content="hi")],
        tools=_TOOLS,
    )
    assert get_session_header("conv-header-2") is None


def test_pin_chat_system_first_compose_is_node0():
    node0, extra = pin_chat_system("conv-pin-1", "SYS v1")
    assert node0 == "SYS v1"
    assert extra == ""


def test_pin_chat_system_appends_in_history_when_catalog_changes():
    cid = "conv-pin-2"
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content="SYS v1")],
        tools=_TOOLS,
    )
    node0, extra = pin_chat_system(cid, "SYS v2")
    assert node0 == "SYS v1"
    assert extra == "SYS v2"
    same0, same_extra = pin_chat_system(cid, "SYS v1")
    assert same0 == "SYS v1"
    assert same_extra == ""


def test_pin_chat_system_catalog_delta_omits_frozen_base():
    cid = "conv-pin-catalog"
    frozen = "全员基座宪法。\n\n<按需目录>\n- a：旧\n</按需目录>"
    current = "全员基座宪法。\n\n<按需目录>\n- a：旧\n- b：新\n</按需目录>"
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content=frozen)],
        tools=_TOOLS,
    )
    node0, extra = pin_chat_system(cid, current)
    assert node0 == frozen
    assert "- b：新" in extra
    assert "全员基座宪法。" not in extra


def test_pin_chat_tools_first_live_is_opening():
    live = [{"type": "function", "function": {"name": "delegate", "parameters": {}}}]
    assert pin_chat_tools("conv-tools-1", live) == live


def test_pin_chat_tools_same_names_keep_frozen_schema():
    cid = "conv-tools-2"
    frozen = [
        {
            "type": "function",
            "function": {"name": "delegate", "description": "old", "parameters": {}},
        }
    ]
    live = [
        {
            "type": "function",
            "function": {"name": "delegate", "description": "new", "parameters": {}},
        }
    ]
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content="SYS")],
        tools=frozen,
    )
    pinned = pin_chat_tools(cid, live)
    assert pinned[0]["function"]["description"] == "old"


def test_pin_chat_tools_name_change_sends_live():
    cid = "conv-tools-3"
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content="SYS")],
        tools=[{"type": "function", "function": {"name": "delegate", "parameters": {}}}],
    )
    live = [
        {"type": "function", "function": {"name": "delegate", "parameters": {}}},
        {"type": "function", "function": {"name": "host", "parameters": {}}},
    ]
    pinned = pin_chat_tools(cid, live)
    assert [d["function"]["name"] for d in pinned] == ["delegate", "host"]


def test_pin_chat_tools_resume_keeps_frozen_on_name_change():
    cid = "conv-tools-4"
    frozen = [{"type": "function", "function": {"name": "delegate", "parameters": {}}}]
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content="SYS")],
        tools=frozen,
    )
    live = [
        {"type": "function", "function": {"name": "delegate", "parameters": {}}},
        {"type": "function", "function": {"name": "mcp_foo", "parameters": {}}},
    ]
    pinned = pin_chat_tools(cid, live, allow_header_change=False)
    assert [d["function"]["name"] for d in pinned] == ["delegate"]


def test_header_usage_roundtrip_drops_non_dict_tools():
    header = SessionLlmHeader(
        system="SYS",
        tools=({"type": "function", "function": {"name": "delegate"}}, "skip"),
        model="  m  ",
    )
    blob = header_to_usage(header)
    assert blob[FROZEN_CHAT_SYSTEM_USAGE_KEY] == "SYS"
    parsed = header_from_usage(
        {
            **blob,
            CHAT_HEADER_TOOLS_USAGE_KEY: [
                {"type": "function", "function": {"name": "delegate"}},
                "skip",
            ],
            CHAT_HEADER_MODEL_USAGE_KEY: "  m  ",
        }
    )
    assert parsed is not None
    assert parsed.system == "SYS"
    assert parsed.model == "m"
    assert parsed.tools == ({"type": "function", "function": {"name": "delegate"}},)
    assert header_from_usage({"origin": "execution_harvest"}) is None


@pytest.mark.asyncio
async def test_hydrate_lru_hit_skips_db(monkeypatch: pytest.MonkeyPatch):
    cid = "conv-hydrate-lru"
    record_session_header(
        conversation_id=cid,
        scenario="chat",
        model="m",
        messages=[LLMMessage(role="system", content="CEO SYS")],
        tools=_TOOLS,
    )

    async def _boom(_cid: str) -> None:
        raise AssertionError("must not load stamped header")

    monkeypatch.setattr(
        "agentcore.observability.session_llm_header.load_stamped_session_header",
        _boom,
    )
    header = await hydrate_session_header(cid)
    assert header is not None
    assert header.system == "CEO SYS"


@pytest.mark.asyncio
async def test_hydrate_from_user_usage_skips_harvest_then_pins(
    monkeypatch: pytest.MonkeyPatch,
):
    cid = "conv-hydrate-db"

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def list_recent(self, conversation_id: str, *, limit: int) -> list:
            assert conversation_id == cid
            assert limit > 0
            return [
                SimpleNamespace(
                    role="user",
                    usage={
                        FROZEN_CHAT_SYSTEM_USAGE_KEY: "OLD SYS",
                        CHAT_HEADER_TOOLS_USAGE_KEY: [
                            {"type": "function", "function": {"name": "web_search"}}
                        ],
                        CHAT_HEADER_MODEL_USAGE_KEY: "old",
                    },
                ),
                SimpleNamespace(
                    role="user",
                    usage={
                        "origin": "execution_harvest",
                        FROZEN_CHAT_SYSTEM_USAGE_KEY: "HARVEST SYS",
                        CHAT_HEADER_TOOLS_USAGE_KEY: [
                            {"type": "function", "function": {"name": "wrong"}}
                        ],
                        CHAT_HEADER_MODEL_USAGE_KEY: "flash",
                    },
                ),
                SimpleNamespace(
                    role="user",
                    usage={
                        FROZEN_CHAT_SYSTEM_USAGE_KEY: "FROZEN SYS",
                        CHAT_HEADER_TOOLS_USAGE_KEY: _TOOLS,
                        CHAT_HEADER_MODEL_USAGE_KEY: "deepseek-v4-pro",
                    },
                ),
                SimpleNamespace(role="assistant", usage=None),
            ]

    class _SessionCM:
        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, *_a: object) -> None:
            return None

    monkeypatch.setattr("agentcore.db.base.async_session_factory", lambda: _SessionCM())
    monkeypatch.setattr("agentcore.db.repositories.MessageRepository", _Repo)

    header = await hydrate_session_header(cid)
    assert header is not None
    assert header.system == "FROZEN SYS"
    assert header.model == "deepseek-v4-pro"
    assert header.tools[0]["function"]["name"] == "delegate"
    assert get_session_header(cid) is header
    node0, extra = pin_chat_system(cid, "SYS v2")
    assert node0 == "FROZEN SYS"
    assert extra == "SYS v2"


@pytest.mark.asyncio
async def test_hydrate_db_failure_does_not_raise(monkeypatch: pytest.MonkeyPatch):
    async def _boom(_cid: str) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(
        "agentcore.observability.session_llm_header.load_stamped_session_header",
        _boom,
    )
    assert await hydrate_session_header("conv-hydrate-fail") is None
