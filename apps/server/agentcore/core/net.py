"""Shared outbound-HTTP infrastructure: timeouts, error description, SSRF guard.

These primitives are pure, stateless infra (no business-module dependencies), so
they live in ``core`` and are consumed by *both* the web tools
(``tools/builtin/web``) and HTTP routes that fetch the open internet (e.g. the
favicon proxy). Keeping them here avoids an ``api -> tools`` import just to reuse
a security guard, and guarantees the favicon proxy and ``read_url`` apply the
*same* SSRF policy (one definition, no drift).

What lives here (stateless):
- :func:`web_timeout` — an ``httpx.Timeout`` with a short connect deadline
  (blocked hosts fail fast) and a longer read window (slow sites still succeed).
- :func:`describe_net_error` — turn opaque httpx errors into an honest,
  model-facing reason (so logs show the real cause, not ``error: ""``).
- :func:`site_of` — display hostname for source/citation cards.
- :func:`classify_url` / :func:`is_safe_url` — the SSRF guard: reject
  non-http(s), reserved hostnames, and any host that resolves to a
  private/loopback/link-local/reserved address (blocks cloud-metadata SSRF).

The *stateful* per-host egress circuit breaker stays in
``tools/builtin/web/_net`` (it is agent-runtime egress state, not generic infra)
and re-exports the names above for backward compatibility.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
from enum import Enum
from urllib.parse import urlparse

import httpx

# Overall search read budget. Kept >= SearXNG's own max_request_timeout (15s, see
# deploy/searxng/settings.yml): a search fans out to several China engines and can
# legitimately take >10s under load, so a tighter client deadline would abandon
# results SearXNG would still return. Connect still uses the short
# WEB_CONNECT_TIMEOUT, so a genuinely down host fast-fails into the breaker.
SEARCH_TIMEOUT = 16.0
WEB_CONNECT_TIMEOUT = 5.0  # connect deadline: blocked hosts fail fast
WEB_READ_TIMEOUT = 15.0  # read window for slow-but-reachable sites


class EgressError(Exception):
    """Raised when the per-host breaker short-circuits an outbound request.

    Its ``str()`` is the honest, model-facing reason, so callers can surface it
    directly without re-wrapping.
    """


def web_timeout(read: float = WEB_READ_TIMEOUT) -> httpx.Timeout:
    """Timeout with a short connect deadline and a configurable read window."""
    return httpx.Timeout(read, connect=WEB_CONNECT_TIMEOUT)


def site_of(url: str) -> str:
    """Display hostname for a URL: lowercased, sans a leading ``www.``.

    Used to label source/citation cards. Returns ``""`` when the URL has no
    parseable host (the card then falls back to the title/url).
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _is_ssl_error(e: BaseException) -> bool:
    """True when an exception (or its cause chain) is a TLS/cert-verification failure.

    httpx wraps the handshake's ``ssl.SSLError`` in an ``httpx.ConnectError`` whose own
    ``str()`` is often empty, so the generic「无法建立连接」branch would mislabel a broken
    cert chain as「出网受限」— a real, high-frequency case for China gov/court sites (see
    实测案例复盘.md 案例 1). Walk the ``__cause__``/``__context__`` chain for an
    ``ssl.SSLError`` (with a string fallback for the verify-failed marker).
    """
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, ssl.SSLError):
            return True
        cur = cur.__cause__ or cur.__context__
    return "CERTIFICATE_VERIFY_FAILED" in str(e)


def describe_net_error(e: BaseException) -> str:
    """Readable reason for a failed outbound request.

    httpx timeout/connect errors frequently stringify to ``""``; surface the
    failure type plus a plain-language hint so both the log and the model see a
    real cause instead of an empty string.
    """
    if isinstance(e, EgressError):
        return str(e)
    if _is_ssl_error(e):
        return (
            "SSL 证书校验失败（站点证书链不被信任，常见于国内部分政务/法院站点）；"
            "改用 web_search 摘要或换其它来源，勿对同一站点反复重试"
        )
    if isinstance(e, httpx.ConnectTimeout):
        return "连接超时（无法连上该站点，可能出网受限或站点不可达）"
    if isinstance(e, httpx.ReadTimeout):
        return "读取超时（站点响应过慢）"
    if isinstance(e, (httpx.ConnectError, httpx.NetworkError)):
        detail = str(e).strip()
        return "无法建立连接（出网受限或站点不可达）" + (f": {detail}" if detail else "")
    if isinstance(e, httpx.TimeoutException):
        return "请求超时"
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    detail = str(e).strip()
    return f"{type(e).__name__}" + (f": {detail}" if detail else "")


# --- SSRF guard -------------------------------------------------------------
# One definition, shared by read_url (the tool) and the favicon proxy (a route),
# so both apply identical private-network protection with no drift.

_BLOCKED_HOSTNAMES = {"localhost", "0.0.0.0", "metadata.google.internal"}


class URLBlock(Enum):
    """URL 被拒原因；value 为面向模型的诚实错误信息。

    把「DNS 解析失败/网络不可达」与「真·SSRF 拦截」区分开 —— 旧实现把两者都
    报成「私有/内网」，既误导模型反复重试，也掩盖了环境层面的网络问题。
    """

    BAD_SCHEME = "[ERROR] 仅支持 http/https 链接"
    BLOCKED_HOST = "[ERROR] 该主机名禁止访问（本地/内网保留域名）"
    DNS_FAIL = (
        "[ERROR] 无法解析该域名（DNS 解析失败或网络不可达）。"
        "请确认链接拼写正确且可公网访问；若反复出现，可能是当前环境出网受限。"
    )
    PRIVATE_IP = "[ERROR] 链接解析到私有/保留地址，已按 SSRF 防护拦截"


def ip_is_safe(ip: str) -> bool:
    """True only for globally-routable addresses (blocks private/metadata)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local  # 含云元数据 169.254.169.254
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


async def classify_url(url: str) -> URLBlock | None:
    """SSRF 检查并区分拒绝原因；返回 None 表示可安全请求。

    域名经 DNS 解析后，只要任一解析地址落在私网/回环/链路本地/保留段即拒绝
    （封堵「域名指向内网/169.254.169.254」这类绕过）。
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return URLBlock.BAD_SCHEME
        hostname = (parsed.hostname or "").strip().rstrip(".").lower()
        if not hostname:
            return URLBlock.BAD_SCHEME
        if hostname in _BLOCKED_HOSTNAMES:
            return URLBlock.BLOCKED_HOST
        if hostname.endswith(".local") or hostname.endswith(".internal"):
            return URLBlock.BLOCKED_HOST

        try:
            ipaddress.ip_address(hostname)
            return None if ip_is_safe(hostname) else URLBlock.PRIVATE_IP
        except ValueError:
            pass  # 不是字面 IP，下面走 DNS 解析

        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                hostname, None, proto=socket.IPPROTO_TCP
            )
        except OSError:
            return URLBlock.DNS_FAIL
        addrs = {info[4][0] for info in infos}
        if not addrs:
            return URLBlock.DNS_FAIL
        if not all(ip_is_safe(a) for a in addrs):
            return URLBlock.PRIVATE_IP
        return None
    except Exception:
        return URLBlock.DNS_FAIL


async def is_safe_url(url: str) -> bool:
    """Bool 包装：用于重定向逐跳重校验。"""
    return await classify_url(url) is None


__all__ = [
    "SEARCH_TIMEOUT",
    "WEB_CONNECT_TIMEOUT",
    "WEB_READ_TIMEOUT",
    "EgressError",
    "URLBlock",
    "classify_url",
    "describe_net_error",
    "ip_is_safe",
    "is_safe_url",
    "site_of",
    "web_timeout",
]
