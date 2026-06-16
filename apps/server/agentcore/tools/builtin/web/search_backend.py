"""Search backend — pluggable web search for built-in tools.

Default implementation talks to a self-hosted SearXNG instance whose engine set
is curated to mainland-China-reachable engines (baidu/360search/sogou/quark, see
``deploy/searxng/settings.yml``) — the public engines (google/ddg/brave) time
out from a China-hosted server. The ``SearchBackend`` protocol allows swapping in
Tavily or another provider without touching the tool layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from urllib.parse import urlparse

import httpx

from agentcore.config import settings
from agentcore.tools.builtin.web._net import (
    EgressError,
    SEARCH_TIMEOUT,
    circuit_remaining,
    note_failure,
    note_success,
)

DEFAULT_MAX_RESULTS = 5


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

    def _get_client(self) -> httpx.AsyncClient:
        """Lazily build the shared client, bound to the running event loop.

        Lazy (not built in ``__init__``) so the client attaches to the server's
        loop at first use, not import time. Single event loop → there is no
        ``await`` between the None-check and the assignment, so concurrent first
        callers can't double-build.
        """
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=SEARCH_TIMEOUT)
        return self._client

    async def aclose(self) -> None:
        """Close the persistent client and drop it (idempotent; re-lazies on next use)."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        host = _searxng_host(self.base_url)
        remaining = circuit_remaining(host)
        if remaining > 0:
            raise EgressError(
                f"搜索服务 {host} 近期连续不可用，已临时熔断约 {int(remaining)}s"
                "（SearXNG 未就绪或出网受限），暂不重试"
            )

        params = {"q": query, "format": "json", "safesearch": "0"}
        client = self._get_client()
        try:
            resp = await client.get(f"{self.base_url}/search", params=params)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.TimeoutException, httpx.NetworkError):
            note_failure(host)
            raise
        except httpx.HTTPStatusError as e:
            if e.response.status_code >= 500:
                note_failure(host)
            raise
        else:
            note_success(host)
        return _parse_results(data, max_results)


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
