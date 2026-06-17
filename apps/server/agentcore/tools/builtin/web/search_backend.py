"""Search backend — pluggable web search for built-in tools.

Default implementation talks to a self-hosted SearXNG instance whose engine set
is curated to mainland-China-reachable engines (baidu/360search/sogou/quark, see
``deploy/searxng/settings.yml``) — the public engines (google/ddg/brave) time
out from a China-hosted server. The ``SearchBackend`` protocol allows swapping in
Tavily or another provider without touching the tool layer.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.tools.builtin.web._net import (
    SEARCH_TIMEOUT,
    WEB_CONNECT_TIMEOUT,
    EgressError,
    circuit_remaining,
    note_failure,
    note_success,
)

logger = get_logger(__name__)

DEFAULT_MAX_RESULTS = 5

# Cap concurrent in-flight requests to the single self-hosted SearXNG instance. A
# parallel team (A/B/C unlocked multi-worker research) can otherwise fire dozens of
# searches at once, saturating SearXNG's worker/accept pool → connections time out →
# 3 in a row trip the shared per-host breaker → the WHOLE team goes search-blind for
# the cooldown. The semaphore makes the burst queue into manageable waves instead of
# self-DOSing; tune up if SearXNG is scaled out.
_SEARCH_CONCURRENCY = 6

# Transient gateway/server errors (notably SearXNG 502 when an upstream engine
# hiccups) frequently clear on a quick retry, so a 5xx is retried a couple of times
# with jittered backoff. Connect / timeout failures are NOT retried here: a down or
# blocked host should fast-fail into the per-host circuit breaker rather than stall
# on backoff. 4xx are client errors and are never retried.
_SEARCH_ATTEMPTS = 3
_SEARCH_RETRY_BASE_S = 0.3
_SEARCH_RETRY_JITTER_S = 0.3


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


class SearchBackend(Protocol):
    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        ...


def _parse_results(data: dict[str, Any], max_results: int) -> list[SearchResult]:
    """Filter + dedup + truncate a SearXNG JSON payload into SearchResults.

    SearXNG already orders results by cross-engine aggregate score, so we keep
    insertion order: drop entries missing url/title, dedup by normalized url
    (strip ``#fragment`` and trailing ``/`` so the same page from multiple
    engines collapses), then take the top ``max_results``.
    """
    results: list[SearchResult] = []
    seen: set[str] = set()
    for item in data.get("results", []):
        url = (item.get("url") or "").strip()
        title = (item.get("title") or "").strip()
        if not url or not title:
            continue
        key = url.split("#", 1)[0].rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        results.append(SearchResult(title=title, url=url, snippet=item.get("content") or ""))
        if len(results) >= max_results:
            break
    return results


def _searxng_host(base_url: str) -> str:
    return (urlparse(base_url).hostname or "localhost").lower()


class SearXNGBackend:
    """Search via a self-hosted SearXNG instance (JSON API).

    Holds a persistent ``httpx.AsyncClient``: every query hits the SAME fixed
    SearXNG host, so a long-lived client reuses the connection (keep-alive) across
    searches instead of paying a fresh TCP+TLS handshake per call. The backend is a
    process-wide singleton (:func:`get_search_backend`); its client is closed on app
    shutdown via :func:`aclose_search_backend`.
    """

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or settings.searxng_url).rstrip("/")
        self._client: httpx.AsyncClient | None = None
        self._sem: asyncio.Semaphore | None = None

    def _get_client(self) -> httpx.AsyncClient:
        """Lazily build the shared client, bound to the running event loop.

        Lazy (not built in ``__init__``) so the client attaches to the server's
        loop at first use, not import time. Single event loop → there is no
        ``await`` between the None-check and the assignment, so concurrent first
        callers can't double-build.

        Connect uses the short ``WEB_CONNECT_TIMEOUT`` (a down host fast-fails into
        the breaker) while the overall budget is the generous ``SEARCH_TIMEOUT`` —
        a multi-engine search is slow-but-reachable, not unreachable.
        """
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(SEARCH_TIMEOUT, connect=WEB_CONNECT_TIMEOUT)
            )
        return self._client

    def _get_sem(self) -> asyncio.Semaphore:
        """Lazily build the concurrency gate, bound to the running event loop.

        Lazy for the same reason as the client: an ``asyncio.Semaphore`` binds to
        the loop on first acquire, so building it here (right before ``async with``)
        keeps it on the server's loop rather than import time.
        """
        if self._sem is None:
            self._sem = asyncio.Semaphore(_SEARCH_CONCURRENCY)
        return self._sem

    async def aclose(self) -> None:
        """Close the persistent client and drop it (idempotent; re-lazies on next use)."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._sem = None  # re-lazied (rebinds to a fresh loop) on next use

    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        host = _searxng_host(self.base_url)
        remaining = circuit_remaining(host)
        if remaining > 0:
            # Honest cause: the breaker only opens after repeated request failures
            # (timeout / connection). Don't assert "未就绪/出网受限" — under a parallel
            # burst SearXNG is usually up but overloaded, and a misleading message
            # sends devs hunting a service that started fine. Checked BEFORE the
            # semaphore so a fast-fail never consumes a concurrency slot.
            raise EgressError(
                f"搜索服务 {host} 最近连续多次请求失败（超时或连接失败），"
                f"已临时熔断约 {int(remaining)}s，暂不重试；"
                f"若刚启动请稍候，或检查 {host} 是否过载/可达"
            )

        params = {"q": query, "format": "json", "safesearch": "0"}
        client = self._get_client()
        async with self._get_sem():  # throttle the parallel-team burst (see _SEARCH_CONCURRENCY)
            for attempt in range(_SEARCH_ATTEMPTS):
                try:
                    resp = await client.get(f"{self.base_url}/search", params=params)
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.TimeoutException, httpx.NetworkError):
                    # A down / blocked host: fast-fail into the breaker, do not retry.
                    note_failure(host)
                    raise
                except httpx.HTTPStatusError as e:
                    status = e.response.status_code
                    if status < 500:
                        raise  # client error (4xx): not transient, not a breaker fault
                    if attempt + 1 >= _SEARCH_ATTEMPTS:
                        note_failure(host)  # one failure per call, after exhausting retries
                        raise
                    delay = _SEARCH_RETRY_BASE_S * (2**attempt) + random.uniform(
                        0, _SEARCH_RETRY_JITTER_S
                    )
                    logger.info(
                        "tool.web_search_retry", host=host, attempt=attempt + 1, status=status
                    )
                    await asyncio.sleep(delay)
                else:
                    note_success(host)
                    return _parse_results(data, max_results)
        # Defensive: the loop always returns or raises on its last iteration.
        raise EgressError(f"搜索服务 {host} 连续返回服务端错误（5xx），已停止重试")


_backend: SearchBackend | None = None


def get_search_backend() -> SearchBackend:
    global _backend
    if _backend is None:
        _backend = SearXNGBackend()
    return _backend


async def aclose_search_backend() -> None:
    """Close the process-wide search backend's HTTP client (app shutdown / tests).

    Wired into the app lifespan so the SearXNG keep-alive pool is released cleanly
    (no "Unclosed client" warning, no leaked sockets). Also the reset hook tests use
    to drop a backend built against a patched client. No-op if never built or if the
    backend impl owns no client.
    """
    global _backend
    if isinstance(_backend, SearXNGBackend):
        await _backend.aclose()
    _backend = None


async def probe_search_backend() -> tuple[bool, str] | None:
    """Best-effort SearXNG reachability check, logged ✓/✗ for a startup line.

    Returns ``(ok, detail)``, or ``None`` when the active backend isn't SearXNG
    (nothing to probe). **Never raises** — a down search dependency must not break
    app startup (``web_search`` just degrades). Surfaced at boot so a not-started /
    unreachable SearXNG is visible immediately instead of only later as a (now
    honest) breaker message mid-run. Uses a throwaway client against ``/healthz``
    with the short connect deadline so the check itself can't hang startup.
    """
    backend = get_search_backend()
    if not isinstance(backend, SearXNGBackend):
        return None  # custom backend (e.g. Tavily): nothing SearXNG-specific to probe
    base = backend.base_url
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=WEB_CONNECT_TIMEOUT)
        ) as client:
            resp = await client.get(f"{base}/healthz")
        ok = resp.status_code == 200
        detail = base if ok else f"{base} (HTTP {resp.status_code})"
    except Exception as exc:  # noqa: BLE001 - best-effort; any failure == unreachable
        ok = False
        detail = f"{base} ({type(exc).__name__})"
    if ok:
        logger.info("searxng.reachable", url=detail)
    else:
        logger.warning(
            "searxng.unreachable",
            target=detail,
            hint="web_search 将不可用，直到 SearXNG 就绪："
            "docker compose -f deploy/docker-compose.dev.yml up -d searxng",
        )
    return ok, detail
