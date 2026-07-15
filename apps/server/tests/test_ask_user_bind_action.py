"""ask_user option ``action`` normalize + schema advertising."""

from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.tools.builtin.ask_user.schema import normalize_options, normalize_questions
from agentcore.tools.builtin.ask_user.tool import AskUserTool


def test_normalize_options_preserves_bind_local_folder_action():
    out = normalize_options(
        [
            {"label": "绑定本地文件夹", "action": "bind_local_folder", "recommended": True},
            {"label": "继续用云端", "detail": "无法打开本机应用"},
            {"label": "坏动作", "action": "hack_the_planet"},
            {"label": "授权只读目录", "action": "grant_readonly_folder"},
        ]
    )
    assert out[0]["action"] == "bind_local_folder"
    assert out[0]["recommended"] is True
    assert "action" not in out[1]
    assert "action" not in out[2]  # unknown actions drop
    assert out[3]["action"] == "grant_readonly_folder"


def test_normalize_questions_passthrough_to_checkpoint_shape():
    qs = normalize_questions(
        [
            {
                "prompt": "如何对齐工作区？",
                "kind": "choice",
                "options": [
                    {"label": "绑定本地文件夹", "action": "bind_local_folder"},
                    {"label": "先用云端"},
                ],
            }
        ]
    )
    assert qs[0]["options"][0]["action"] == "bind_local_folder"
    assert "action" not in qs[0]["options"][1]


def test_ask_user_schema_advertises_action_only_when_flagged():
    sink = EventSink()
    base = dict(
        sink=sink,
        conversation_id="c1",
        registry=default_interaction_registry(),
        timeout_seconds=30.0,
    )
    plain = AskUserTool(**base, advertise_bind_local_folder=False)
    props = plain.schema.parameters["properties"]["questions"]["items"]["properties"]["options"][
        "items"
    ]["properties"]
    assert "action" not in props
    assert "bind_local_folder" not in plain.schema.description

    advertised = AskUserTool(**base, advertise_bind_local_folder=True)
    props2 = advertised.schema.parameters["properties"]["questions"]["items"]["properties"][
        "options"
    ]["items"]["properties"]
    assert props2["action"]["enum"] == ["bind_local_folder", "grant_readonly_folder"]
    assert "bind_local_folder" in advertised.schema.description
    assert "grant_readonly_folder" in advertised.schema.description
