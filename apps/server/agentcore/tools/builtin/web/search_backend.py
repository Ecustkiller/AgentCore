"""Search backend — pluggable web search for built-in tools.

The default primary talks to a self-hosted SearXNG instance whose engine set is
curated to mainland-China-reachable engines (baidu/360search/sogou/quark, see
``deploy/searxng/settings.yml``) — the public engines (google/ddg/brave) time out
from a China-hosted server.

The ``SearchBackend`` protocol's second implementation is :class:`TavilyBackend`
(a hosted search API reachable from outside mainland China). When a Tavily key is
configured, :func:`get_search_backend` wraps the SearXNG primary in a
:class:`FallbackSearchBackend` so a query that *fails* on SearXNG (breaker-open /
transport / persistent 5xx — the "whole team goes search-blind" mode from
``实测案例复盘`` 案例1) retries once via Tavily. SearXNG stays the primary so normal
queries pay no Tavily cost; Tavily fires only on a primary failure.
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
    describe_net_error,
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
    ) -> list[SearchResult]: ...


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


# Tavily caps max_results at 20 (0-20); clamp defensively though the tool layer
# already bounds the request to ≤12.
_TAVILY_MAX_RESULTS_CAP = 20
_TAVILY_SEARCH_PATH = "/search"


class TavilyBackend:
    """Search via the Tavily API — the reliable fallback when SearXNG is unusable.

    Tavily is a hosted search API reachable from outside mainland China, so it
    covers the exact gap that strands the self-hosted SearXNG primary (overload →
    breaker open, or restricted egress). It is the second ``SearchBackend`` the
    protocol was designed for, wired in ONLY as the fallback leg of
    :class:`FallbackSearchBackend` (never the default) so steady-state queries keep
    hitting the free self-hosted instance and incur no per-query Tavily cost.

    Tavily's result objects expose ``title`` / ``url`` / ``content`` — the same
    shape SearXNG returns — so :func:`_parse_results` parses both. Holds a
    persistent ``httpx.AsyncClient`` (keep-alive to the fixed Tavily host), closed
    on shutdown via the wrapping backend's ``aclose``.
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key if api_key is not None else settings.tavily_api_key
        self.base_url = (base_url or settings.tavily_base_url).rstrip("/")
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        """Lazily build the shared client, bound to the running event loop.

        Lazy (not in ``__init__``) so the client attaches to the server's loop at
        first use, mirroring :class:`SearXNGBackend`. Connect uses the short
        ``WEB_CONNECT_TIMEOUT`` (a down host fast-fails) under the generous overall
        ``SEARCH_TIMEOUT`` read budget.
        """
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(SEARCH_TIMEOUT, connect=WEB_CONNECT_TIMEOUT)
            )
        return self._client

    async def aclose(self) -> None:
        """Close the persistent client and drop it (idempotent; re-lazies on next use)."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        # Guard: only reached if mis-wired without a key (get_search_backend builds
        # this backend only when a key is set). Honest, model-facing reason.
        if not self.api_key:
            raise EgressError("Tavily 回退搜索未配置 API key（设置 TAVILY_API_KEY 启用）")

        payload = {
            "query": query,
            "max_results": max(1, min(max_results, _TAVILY_MAX_RESULTS_CAP)),
            "search_depth": "basic",
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        client = self._get_client()
        # No retry / no breaker here: Tavily is the fallback leg, called per-query
        # only after the primary already failed. One honest attempt — its errors
        # propagate to FallbackSearchBackend, which logs and surfaces the primary's
        # (already tuned) reason. Keeps this leg simple and side-effect free.
        resp = await client.post(
            f"{self.base_url}{_TAVILY_SEARCH_PATH}", json=payload, headers=headers
        )
        resp.raise_for_status()
        return _parse_results(resp.json(), max_results)


class FallbackSearchBackend:
    """A primary backend with a fallback leg: try primary, on FAILURE try fallback.

    The primary (self-hosted SearXNG) stays the default path so normal queries pay
    no external-API cost; the fallback (Tavily) fires ONLY when the primary raises —
    breaker-open / transport failure / persistent 5xx, i.e. the 案例1 "whole team
    goes search-blind" mode. A successful (even empty-result) primary never calls
    the fallback: this catches *failures*, not thin recall, to keep the change
    bounded and the cost predictable.

    If BOTH legs fail, the PRIMARY's exception is surfaced — it is the configured
    default and its ``EgressError`` text is the already-tuned, honest reason the
    model acts on; the fallback's failure is logged for diagnosis.
    """

    def __init__(self, primary: SearchBackend, fallback: SearchBackend) -> None:
        self.primary = primary
        self.fallback = fallback

    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        try:
            return await self.primary.search(query, max_results=max_results)
        except Exception as primary_exc:  # noqa: BLE001 - any primary failure → try fallback
            logger.warning(
                "search.primary_failed_try_fallback",
                reason=describe_net_error(primary_exc),
                error_repr=repr(primary_exc),
            )
            try:
                results = await self.fallback.search(query, max_results=max_results)
            except Exception as fb_exc:  # noqa: BLE001 - both down → surface primary's reason
                logger.warning(
                    "search.fallback_failed",
                    reason=describe_net_error(fb_exc),
                    error_repr=repr(fb_exc),
                )
                raise primary_exc from fb_exc
            logger.info("search.fallback_succeeded", result_count=len(results))
            return results

    async def aclose(self) -> None:
        """Close both legs' clients (best-effort; one failure can't block the other)."""
        for backend in (self.primary, self.fallback):
            closer = getattr(backend, "aclose", None)
            if closer is None:
                continue
            try:
                await closer()
            except Exception:  # noqa: BLE001 - best-effort shutdown cleanup
                logger.warning("search.backend_aclose_failed", backend=type(backend).__name__)


_backend: SearchBackend | None = None


def get_search_backend() -> SearchBackend:
    """Build (once) the process-wide search backend.

    SearXNG is always the primary. When a Tavily key is configured it is wrapped in
    a :class:`FallbackSearchBackend` so a primary failure retries via Tavily;
    otherwise the bare SearXNG backend is returned (behaviour unchanged).
    """
    global _backend
    if _backend is None:
        primary = SearXNGBackend()
        if settings.tavily_api_key:
            _backend = FallbackSearchBackend(primary, TavilyBackend())
            logger.info("search.backend_ready", primary="searxng", fallback="tavily")
        else:
            _backend = primary
    return _backend


async def aclose_search_backend() -> None:
    """Close the process-wide search backend's HTTP client(s) (app shutdown / tests).

    Wired into the app lifespan so the SearXNG (and, when configured, Tavily)
    keep-alive pools are released cleanly (no "Unclosed client" warning, no leaked
    sockets). Also the reset hook tests use to drop a backend built against a patched
    client. Duck-typed: closes any backend exposing ``aclose`` (SearXNG / Tavily /
    the fallback wrapper, which closes both legs). No-op if never built.
    """
    global _backend
    backend = _backend
    _backend = None
    if backend is not None:
        closer = getattr(backend, "aclose", None)
        if closer is not None:
            await closer()


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
    if isinstance(backend, FallbackSearchBackend):
        backend = backend.primary  # probe the SearXNG primary behind the fallback
    if not isinstance(backend, SearXNGBackend):
        return None  # custom backend (e.g. pure Tavily): nothing SearXNG-specific to probe
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
