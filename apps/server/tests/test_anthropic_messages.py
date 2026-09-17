"""LLMRequest ↔ Anthropic /messages mapping (no HTTP)."""

from __future__ import annotations

from agentcore.llm.provider.anthropic_messages import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_THINKING_BUDGET,
    AnthropicSseAssembler,
    build_messages_payload,
    convert_tool_choice,
    convert_tools,
    fold_history,
    map_stop_reason,
    parse_unary_message,
    thinking_payload,
)
from agentcore.llm.provider.protocol import (
    LLMMessage,
    LLMRequest,
    ToolCall,
    ToolCallFunction,
)


def _tool(name: str, arguments: str, call_id: str = "toolu_1") -> ToolCall:
    return ToolCall(id=call_id, function=ToolCallFunction(name=name, arguments=arguments))


def test_map_stop_reason():
    assert map_stop_reason("tool_use") == "tool_calls"
    assert map_stop_reason("max_tokens") == "length"
    assert map_stop_reason("end_turn") == "stop"
    assert map_stop_reason(None) == "stop"


def test_convert_tools_from_openai_function_shape():
    tools = convert_tools(
        [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "read",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                    },
                },
            }
        ]
    )
    assert tools == [
        {
            "name": "read_file",
            "description": "read",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        }
    ]


def test_convert_tool_choice():
    assert convert_tool_choice("none") == {"type": "none"}
    assert convert_tool_choice("required") == {"type": "any"}
    assert convert_tool_choice("auto") == {"type": "auto"}


def test_fold_history_echoes_signed_thinking_blocks():
    system, wire = fold_history(
        [
            LLMMessage(role="user", content="open it"),
            LLMMessage(
                role="assistant",
                content="",
                reasoning_content="plan",
                thinking_blocks=[
                    {
                        "type": "thinking",
                        "thinking": "plan",
                        "signature": "sig_abc",
                    }
                ],
                tool_calls=[_tool("read_file", '{"path": "a.txt"}')],
            ),
            LLMMessage(role="tool", content="hello", tool_call_id="toolu_1"),
        ]
    )
    assert system == ""
    assert wire[0]["role"] == "user"
    assert wire[1]["content"][0] == {
        "type": "thinking",
        "thinking": "plan",
        "signature": "sig_abc",
    }
    assert wire[1]["content"][1]["type"] == "tool_use"


def test_fold_history_drops_unsigned_thinking_blocks():
    _system, wire = fold_history(
        [
            LLMMessage(
                role="assistant",
                content="hi",
                thinking_blocks=[{"type": "thinking", "thinking": "plan"}],
            )
        ]
    )
    assert wire[0]["content"] == [{"type": "text", "text": "hi"}]


def test_fold_history_peels_system_and_folds_tool_results():
    system, wire = fold_history(
        [
            LLMMessage(role="system", content="you are helpful"),
            LLMMessage(role="user", content="open it"),
            LLMMessage(
                role="assistant",
                content="",
                tool_calls=[_tool("read_file", '{"path": "a.txt"}')],
            ),
            LLMMessage(role="tool", content="hello", tool_call_id="toolu_1"),
            LLMMessage(role="assistant", content="done"),
        ]
    )
    assert system == "you are helpful"
    assert wire[0] == {"role": "user", "content": "open it"}
    assert wire[1]["role"] == "assistant"
    assert wire[1]["content"] == [
        {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "read_file",
            "input": {"path": "a.txt"},
        }
    ]
    assert wire[2] == {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "hello",
            }
        ],
    }
    assert wire[3]["role"] == "assistant"
    assert wire[3]["content"] == [{"type": "text", "text": "done"}]


def test_fold_history_maps_data_uri_images():
    _system, wire = fold_history(
        [
            LLMMessage(
                role="user",
                content=[
                    {"type": "text", "text": "what is this"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,abc"},
                    },
                ],
            )
        ]
    )
    assert wire == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "what is this"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc",
                    },
                },
            ],
        }
    ]


def test_build_messages_payload_defaults_max_tokens_and_sends_temperature():
    payload = build_messages_payload(
        LLMRequest(
            messages=[LLMMessage(role="user", content="hi")],
            model="claude-haiku-4-5",
            temperature=0.7,
            max_tokens=None,
            tools=[
                {
                    "type": "function",
                    "function": {"name": "noop", "description": "", "parameters": {}},
                }
            ],
            tool_choice="required",
        ),
        stream=True,
    )
    assert payload["max_tokens"] == DEFAULT_MAX_TOKENS
    assert payload["stream"] is True
    assert payload["temperature"] == 0.7
    assert "thinking" not in payload
    assert payload["tool_choice"] == {"type": "any"}
    assert payload["tools"][0]["name"] == "noop"


def test_thinking_payload_claude_on_off_and_qwen_omits():
    haiku = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="claude-haiku-4-5",
        thinking=True,
        reasoning_effort="high",
    )
    assert thinking_payload(haiku) == {
        "type": "enabled",
        "budget_tokens": DEFAULT_THINKING_BUDGET,
    }
    off = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="claude-haiku-4-5",
        thinking=False,
    )
    assert thinking_payload(off) == {"type": "disabled"}
    qwen = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="qwen3.7-max",
        thinking=True,
    )
    assert thinking_payload(qwen) is None
    opus = build_messages_payload(
        LLMRequest(
            messages=[LLMMessage(role="user", content="hi")],
            model="claude-opus-4-7",
            temperature=0.7,
            thinking=False,
        ),
        stream=False,
    )
    assert "temperature" not in opus
    assert opus["thinking"] == {"type": "disabled"}


def test_parse_unary_message_text_thinking_and_tools():
    parsed = parse_unary_message(
        {
            "stop_reason": "tool_use",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "plan",
                    "signature": "sig_1",
                },
                {"type": "text", "text": "calling"},
                {"type": "tool_use", "id": "toolu_9", "name": "grep", "input": {"q": "x"}},
            ],
        }
    )
    assert parsed.content == "calling"
    assert parsed.reasoning == "plan"
    assert parsed.finish_reason == "tool_calls"
    assert parsed.tool_calls is not None
    assert parsed.tool_calls[0].id == "toolu_9"
    assert parsed.tool_calls[0].function.name == "grep"
    assert parsed.tool_calls[0].function.arguments == '{"q": "x"}'
    assert parsed.thinking_blocks == [
        {"type": "thinking", "thinking": "plan", "signature": "sig_1"}
    ]


def test_sse_assembler_text_then_tool_then_stop():
    assembler = AnthropicSseAssembler()
    chunks = []
    lines = [
        'event: message_start',
        'data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":12}}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
        "",
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"read_file"}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\""}}',
        "",
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
        "",
    ]
    for line in lines:
        chunks.extend(assembler.feed_line(line))
    texts = [c.delta_content for c in chunks if c.delta_content]
    assert texts == ["Hi"]
    tool_starts = [c.delta_tool_calls for c in chunks if c.delta_tool_calls]
    assert tool_starts[0][0].id == "toolu_2"
    assert tool_starts[0][0].function_name == "read_file"
    assert tool_starts[1][0].arguments_delta == '{"p"'
    finish = next(c for c in chunks if c.finish_reason)
    assert finish.finish_reason == "tool_calls"
    assert finish.usage is not None
    assert finish.usage.input_tokens == 12
    assert finish.usage.output_tokens == 8
    assert finish.thinking_blocks is None


def test_sse_assembler_thinking_signature_on_finish():
    assembler = AnthropicSseAssembler()
    chunks = []
    lines = [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_z"}}',
        "",
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        "",
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        "",
    ]
    for line in lines:
        chunks.extend(assembler.feed_line(line))
    reason = [c.delta_reasoning for c in chunks if c.delta_reasoning]
    assert reason == ["hmm"]
    finish = next(c for c in chunks if c.finish_reason)
    assert finish.thinking_blocks == [
        {"type": "thinking", "thinking": "hmm", "signature": "sig_z"}
    ]
