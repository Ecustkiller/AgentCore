"""Process-wide httpx clients for LLM upstreams, keyed by origin.

httpx already pools sockets *inside* one ``AsyncClient``. We used to construct a
new client per turn (and ``aclose`` it on teardown), so every first token paid a
fresh TCP+TLS handshake. SearXNG already keeps one long-lived client; this is the
same shape, split by ``base_url`` because BYOK / platform / sidecar inference hop
talk to different hosts.

Auth, custom extra headers, OpenCode session, and Anthropic version stay on the
*request*. Freezing ``Authorization`` onto a shared client would mix tenants on
the same origin. ``Provider.close()`` marks that instance dead (so a cloned
worker survives turn teardown) and must not tear the pooled transport.

httpx's default ``keepalive_expiry`` is 5s — shorter than a typical pause between
turns — so the pool raises it. Process shutdown (API lifespan / sidecar exit)
and test teardown call :func:`aclose_llm_http_pool`.

:func:`warm_llm_origin` is the idle handshake (``GET /models``): any HTTP status
completes TLS and leaves a keep-alive socket. It does not POST chat completions.
"""

from __future__ import annotations

import contextlib
import threading
import time

import httpx

from agentcore.core.logging import get_logger
from agentcore.core.net import outbound_async_client, site_of
from agentcore.llm.opencode_headers import opencode_client_headers

logger = get_logger(__name__)

# Match OpenAICompatibleProvider unary / per-chunk idle ceiling.
_LLM_REQUEST_TIMEOUT = 300.0
_LLM_CONNECT_TIMEOUT = 10.0
# httpx default is 5.0; consecutive turns are usually further apart.
LLM_KEEPALIVE_EXPIRY_S = 60.0
# Idle handshake: short so composer-focus never stalls stdin / UI.
WARM_CONNECT_TIMEOUT_S = 3.0
WARM_REQUEST_TIMEOUT_S = 5.0
LLM_WARM_COOLDOWN_S = 30.0

_LOCK = threading.Lock()
_CLIENTS: dict[str, httpx.AsyncClient] = {}
_WARM_AT: dict[str, float] = {}


def origin_key(base_url: str) -> str:
    """Canonical pool slot: stripped trailing slash, empty if the URL is blank."""
    return (base_url or "").rstrip("/")


def acquire_llm_http_client(base_url: str) -> httpx.AsyncClient:
    """Return the process client for this origin, creating it if missing or closed."""
    key = origin_key(base_url)
    with _LOCK:
        client = _CLIENTS.get(key)
        if client is None or client.is_closed:
            client = _new_client(key)
            _CLIENTS[key] = client
        return client


def peek_llm_http_client(base_url: str) -> httpx.AsyncClient | None:
    """The pooled client for ``base_url``, or ``None`` if this origin was never acquired."""
    with _LOCK:
        return _CLIENTS.get(origin_key(base_url))


def _new_client(base_url: str) -> httpx.AsyncClient:
    headers = {"Content-Type": "application/json", **opencode_client_headers(base_url)}
    return outbound_async_client(
        base_url=base_url,
        headers=headers,
        timeout=httpx.Timeout(_LLM_REQUEST_TIMEOUT, connect=_LLM_CONNECT_TIMEOUT),
        limits=httpx.Limits(
            max_keepalive_connections=20,
            keepalive_expiry=LLM_KEEPALIVE_EXPIRY_S,
        ),
    )


def _authorization_header(authorization: str | None) -> dict[str, str]:
    token = (authorization or "").strip()
    if not token:
        return {}
    if not token.lower().startswith("bearer "):
        token = f"Bearer {token}"
    return {"Authorization": token}


async def warm_llm_origin(
    base_url: str,
    authorization: str | None = None,
) -> bool:
    """Handshake the pooled client with ``GET /models`` (no chat completion).

    Any HTTP status (including 404) is success: the inference proxy has no
    models catalog, but the request still completes TLS and keeps the socket.
    Transport errors are swallowed. Per-origin cooldown skips a second GET.
    ``authorization`` is per-request only — never frozen onto the client.
    """
    stripped = (base_url or "").strip()
    key = origin_key(stripped)
    if not key:
        return False
    now = time.monotonic()
    with _LOCK:
        last = _WARM_AT.get(key)
        if last is not None and now - last < LLM_WARM_COOLDOWN_S:
            return True
    client = acquire_llm_http_client(stripped)
    headers = _authorization_header(authorization)
    host = site_of(stripped) or "unknown"
    ok = False
    try:
        timeout = httpx.Timeout(WARM_REQUEST_TIMEOUT_S, connect=WARM_CONNECT_TIMEOUT_S)
        await client.get("/models", headers=headers or None, timeout=timeout)
        ok = True
    except Exception:  # noqa: BLE001 - handshake must not raise into sidecar stdin
        ok = False
    with _LOCK:
        _WARM_AT[key] = time.monotonic()
    logger.info("llm.http_pool.warmed", host=host, ok=ok)
    return ok


async def aclose_llm_http_pool() -> None:
    """Drop every pooled LLM client (app / sidecar shutdown and test isolation)."""
    with _LOCK:
        clients = list(_CLIENTS.values())
        _CLIENTS.clear()
        _WARM_AT.clear()
    for client in clients:
        with contextlib.suppress(Exception):
            if not client.is_closed:
                await client.aclose()
