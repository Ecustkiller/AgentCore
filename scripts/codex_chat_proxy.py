#!/usr/bin/env python3
"""Local proxy: OpenAI chat/completions -> ChatGPT Codex responses backend.

Targets https://chatgpt.com/backend-api/codex/responses (same path Codex CLI uses).
ChatGPT OAuth tokens lack api.responses.write for api.openai.com/v1/responses.

Usage:
  python scripts/codex_chat_proxy.py [--port 9090] [--cred path/to/creds.json]

Requires a ChatGPT plan with Codex access. Use Codex model slugs such as
``gpt-5.4`` or ``gpt-5.5`` (see ``/backend-api/codex/models``). General ChatGPT
models like ``gpt-4o`` / ``o4-mini`` are rejected by the Codex backend.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

UPSTREAM = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_CRED_PATHS = [
    Path(__file__).resolve().parent.parent / "config" / "codex-credentials.json",
]
DEFAULT_INSTRUCTIONS = "You are a helpful assistant."
_UPSTREAM_TIMEOUT = 120


def load_credentials(path: Path | None = None) -> dict[str, str]:
    paths = [path] if path else DEFAULT_CRED_PATHS
    for p in paths:
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        if "access_token" in data:
            return {
                "access_token": data["access_token"],
                "account_id": data.get("account_id", ""),
                "email": data.get("email", ""),
            }
        creds = data["accounts"][0]["credentials"]
        return {
            "access_token": creds["access_token"],
            "account_id": creds.get("account_id", creds.get("chatgpt_account_id", "")),
            "email": creds.get("email", ""),
        }
    raise FileNotFoundError(f"No credential file found in {paths}")


def messages_to_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            parts: list[dict[str, str]] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append({"type": "input_text", "text": block.get("text", "")})
                elif isinstance(block, str):
                    parts.append({"type": "input_text", "text": block})
            if not parts:
                parts = [{"type": "input_text", "text": json.dumps(content)}]
            items.append({"type": "message", "role": role, "content": parts})
        else:
            items.append(
                {
                    "type": "message",
                    "role": role,
                    "content": [{"type": "input_text", "text": str(content)}],
                }
            )
    return items


def build_responses_body(chat_body: dict[str, Any]) -> dict[str, Any]:
    messages = chat_body.get("messages") or []
    if not messages:
        raise ValueError("messages is required")

    system_parts: list[str] = []
    wire_messages: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role", "user")
        if role == "system":
            content = msg.get("content", "")
            system_parts.append(str(content))
            continue
        wire_messages.append(msg)

    model = chat_body.get("model") or "gpt-5.4"
    body: dict[str, Any] = {
        "model": model,
        "input": messages_to_input(wire_messages),
        "stream": True,
        "store": False,
        # Codex reasons silently unless a summary is requested; without this the
        # model's thinking never surfaces as reasoning_summary events downstream.
        "reasoning": {"summary": "auto"},
    }
    effort = chat_body.get("reasoning_effort")
    if effort:
        body["reasoning"]["effort"] = effort
    if "instructions" in chat_body:
        body["instructions"] = chat_body["instructions"]
    elif system_parts:
        # Codex responses backend rejects system-role items in ``input``; fold them
        # into ``instructions`` (same as Codex CLI) so react_loop system prompts work.
        body["instructions"] = "\n\n".join(system_parts)
    else:
        body["instructions"] = DEFAULT_INSTRUCTIONS
    if chat_body.get("tools"):
        body["tools"] = chat_body["tools"]
    return body


def upstream_headers(token: str, account_id: str) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "OpenAI-Beta": "responses=v1",
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
        headers["chatgpt-account-id"] = account_id
    return headers


def extract_text_from_response_obj(obj: dict[str, Any]) -> str:
    output = obj.get("output") or []
    chunks: list[str] = []
    for item in output:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") in ("output_text", "text"):
                    chunks.append(part.get("text", ""))
        elif item.get("type") == "output_text":
            chunks.append(item.get("text", ""))
    return "".join(chunks)


def extract_reasoning_from_response_obj(obj: dict[str, Any]) -> str:
    output = obj.get("output") or []
    chunks: list[str] = []
    for item in output:
        if item.get("type") == "reasoning":
            for part in item.get("summary") or []:
                if part.get("type") in ("summary_text", "text"):
                    chunks.append(part.get("text", ""))
    return "".join(chunks)


def open_upstream(body: dict[str, Any], creds: dict[str, str]):
    """POST to the Codex backend and return the open SSE response.

    Raises ``RuntimeError`` (carrying a JSON error string) before any bytes are
    streamed, so a stream caller can still surface a clean HTTP error instead of
    a half-open SSE.
    """
    req = Request(
        UPSTREAM,
        data=json.dumps(body).encode(),
        headers=upstream_headers(creds["access_token"], creds["account_id"]),
        method="POST",
    )
    try:
        return urlopen(req, timeout=_UPSTREAM_TIMEOUT)
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            err_obj = json.loads(detail)
        except json.JSONDecodeError:
            err_obj = {"detail": detail}
        raise RuntimeError(json.dumps(err_obj)) from e
    except URLError as e:
        raise RuntimeError(str(e)) from e


def _sse_event(event_type: str, data_lines: list[str]) -> dict[str, Any] | None:
    if not data_lines:
        return None
    payload = "\n".join(data_lines)
    if payload == "[DONE]":
        return None
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return {"event": event_type, "data": parsed}


def iter_sse_from_response(resp) -> Iterator[dict[str, Any]]:
    """Incrementally parse an open SSE response into ``{event, data}`` dicts.

    Emits each event as soon as its terminating blank line arrives, so the proxy
    forwards deltas live instead of buffering the whole upstream response.
    """
    try:
        event_type = "message"
        data_lines: list[str] = []
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line == "":
                event = _sse_event(event_type, data_lines)
                if event is not None:
                    yield event
                event_type = "message"
                data_lines = []
                continue
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
        trailing = _sse_event(event_type, data_lines)
        if trailing is not None:
            yield trailing
    finally:
        resp.close()


def translate_upstream(events: Iterator[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Translate Codex responses events into normalized chat-delta items.

    Yields ``{"delta": {"content": ...}}`` and
    ``{"delta": {"reasoning_content": ...}}`` as they stream, then a trailing
    ``{"final": {...}}`` carrying usage plus a content/reasoning fallback pulled
    from the completed response object (used only when nothing streamed — some
    turns arrive as a single final object).
    """
    saw_content = False
    saw_reasoning = False
    for ev in events:
        data = ev["data"]
        etype = data.get("type") or ev.get("event") or ""
        if etype == "response.output_text.delta":
            delta = data.get("delta", "")
            if isinstance(delta, str) and delta:
                saw_content = True
                yield {"delta": {"content": delta}}
        elif etype == "response.reasoning_summary_text.delta":
            delta = data.get("delta", "")
            if isinstance(delta, str) and delta:
                saw_reasoning = True
                yield {"delta": {"reasoning_content": delta}}
        elif etype in ("response.completed", "response.done"):
            resp_obj = data.get("response")
            resp_obj = resp_obj if isinstance(resp_obj, dict) else {}
            yield {
                "final": {
                    "usage": resp_obj.get("usage") or {},
                    "content": "" if saw_content else extract_text_from_response_obj(resp_obj),
                    "reasoning": ""
                    if saw_reasoning
                    else extract_reasoning_from_response_obj(resp_obj),
                }
            }


def to_chat_completion(
    text: str,
    reasoning: str,
    model: str,
    usage: dict[str, Any] | None,
) -> dict[str, Any]:
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    usage = usage or {}
    prompt_tokens = usage.get("input_tokens", 0)
    completion_tokens = usage.get("output_tokens", 0)
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def to_chat_chunk(
    completion_id: str,
    model: str,
    *,
    delta: dict[str, Any] | None = None,
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    chunk: dict[str, Any] = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        }
    return chunk


def make_handler(creds: dict[str, str]):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path in ("/healthz", "/health", "/"):
                self._json(200, {"status": "ok", "upstream": UPSTREAM, "email": creds.get("email", "")})
                return
            self._json(404, {"error": {"message": "not found", "type": "not_found"}})

        def _sse(self, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

        def _write_sse(self, payload: dict[str, Any] | str) -> None:
            if isinstance(payload, str):
                data = payload
            else:
                data = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            self.wfile.write(data.encode("utf-8"))
            self.wfile.flush()

        def _handle_stream(self, chat_body: dict[str, Any]) -> None:
            responses_body = build_responses_body(chat_body)
            # Open before any SSE bytes: an upstream error still becomes a clean
            # HTTP error via do_POST's RuntimeError handler.
            resp = open_upstream(responses_body, creds)
            model = chat_body.get("model", "unknown")
            completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
            usage: dict[str, Any] = {}
            self._sse()
            self._write_sse(to_chat_chunk(completion_id, model, delta={"role": "assistant"}))
            try:
                for item in translate_upstream(iter_sse_from_response(resp)):
                    if "delta" in item:
                        self._write_sse(to_chat_chunk(completion_id, model, delta=item["delta"]))
                        continue
                    final = item["final"]
                    usage = final["usage"]
                    if final["reasoning"]:
                        self._write_sse(
                            to_chat_chunk(
                                completion_id,
                                model,
                                delta={"reasoning_content": final["reasoning"]},
                            )
                        )
                    if final["content"]:
                        self._write_sse(
                            to_chat_chunk(completion_id, model, delta={"content": final["content"]})
                        )
            except Exception as exc:
                # Best-effort: upstream stalled/dropped mid-stream. Close the SSE
                # cleanly so the client finalizes what it already received.
                sys.stderr.write(f"stream interrupted: {exc}\n")
            self._write_sse(
                to_chat_chunk(completion_id, model, finish_reason="stop", usage=usage)
            )
            self._write_sse("data: [DONE]\n\n")

        def do_POST(self) -> None:
            if self.path not in ("/v1/chat/completions", "/chat/completions"):
                self._json(404, {"error": {"message": "not found", "type": "not_found"}})
                return
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            try:
                chat_body = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                self._json(400, {"error": {"message": "invalid json", "type": "invalid_request_error"}})
                return
            if chat_body.get("stream"):
                try:
                    self._handle_stream(chat_body)
                except ValueError as e:
                    self._json(400, {"error": {"message": str(e), "type": "invalid_request_error"}})
                except RuntimeError as e:
                    msg = str(e)
                    try:
                        err_obj = json.loads(msg)
                    except json.JSONDecodeError:
                        err_obj = {"detail": msg}
                    detail = err_obj.get("detail") or err_obj.get("error", {}).get("message") or msg
                    self._json(502, {"error": {"message": detail, "type": "upstream_error", "raw": err_obj}})
                return
            try:
                responses_body = build_responses_body(chat_body)
                resp = open_upstream(responses_body, creds)
                content_parts: list[str] = []
                reasoning_parts: list[str] = []
                usage: dict[str, Any] = {}
                for item in translate_upstream(iter_sse_from_response(resp)):
                    if "delta" in item:
                        delta = item["delta"]
                        if delta.get("content"):
                            content_parts.append(delta["content"])
                        if delta.get("reasoning_content"):
                            reasoning_parts.append(delta["reasoning_content"])
                        continue
                    final = item["final"]
                    usage = final["usage"]
                    if final["content"]:
                        content_parts.append(final["content"])
                    if final["reasoning"]:
                        reasoning_parts.append(final["reasoning"])
                out = to_chat_completion(
                    "".join(content_parts),
                    "".join(reasoning_parts),
                    chat_body.get("model", "unknown"),
                    usage,
                )
                self._json(200, out)
            except ValueError as e:
                self._json(400, {"error": {"message": str(e), "type": "invalid_request_error"}})
            except RuntimeError as e:
                msg = str(e)
                try:
                    err_obj = json.loads(msg)
                except json.JSONDecodeError:
                    err_obj = {"detail": msg}
                detail = err_obj.get("detail") or err_obj.get("error", {}).get("message") or msg
                self._json(502, {"error": {"message": detail, "type": "upstream_error", "raw": err_obj}})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="Chat completions -> Codex responses proxy")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--cred", type=Path, default=None)
    args = parser.parse_args()

    creds = load_credentials(args.cred)
    print(f"Loaded credentials for {creds.get('email', '(unknown)')}", file=sys.stderr)
    print(f"Listening on http://{args.host}:{args.port}/v1/chat/completions", file=sys.stderr)
    print(f"Upstream: {UPSTREAM}", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), make_handler(creds))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
