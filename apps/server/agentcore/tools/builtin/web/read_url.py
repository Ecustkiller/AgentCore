"""Built-in tool: read_url (fetch a web page and extract its main text)."""

import asyncio
import contextlib
import ipaddress
import json
import re
import socket
import time
from enum import Enum
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.web._net import (
    EgressError,
    circuit_remaining,
    describe_net_error,
    note_failure,
    note_success,
    site_of,
    web_timeout,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)

_DEFAULT_MAX_CHARS = 8000
_MAX_CHARS_CAP = 30000
_MAX_REDIRECTS = 5
_BLOCKED_HOSTNAMES = {"localhost", "0.0.0.0", "metadata.google.internal"}


class _URLBlock(Enum):
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


def _ip_is_safe(ip: str) -> bool:
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


async def _classify_url(url: str) -> _URLBlock | None:
    """SSRF 检查并区分拒绝原因；返回 None 表示可安全请求。

    域名经 DNS 解析后，只要任一解析地址落在私网/回环/链路本地/保留段即拒绝
    （封堵「域名指向内网/169.254.169.254」这类绕过）。
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return _URLBlock.BAD_SCHEME
        hostname = (parsed.hostname or "").strip().rstrip(".").lower()
        if not hostname:
            return _URLBlock.BAD_SCHEME
        if hostname in _BLOCKED_HOSTNAMES:
            return _URLBlock.BLOCKED_HOST
        if hostname.endswith(".local") or hostname.endswith(".internal"):
            return _URLBlock.BLOCKED_HOST

        try:
            ipaddress.ip_address(hostname)
            return None if _ip_is_safe(hostname) else _URLBlock.PRIVATE_IP
        except ValueError:
            pass  # 不是字面 IP，下面走 DNS 解析

        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                hostname, None, proto=socket.IPPROTO_TCP
            )
        except OSError:
            return _URLBlock.DNS_FAIL
        addrs = {info[4][0] for info in infos}
        if not addrs:
            return _URLBlock.DNS_FAIL
        if not all(_ip_is_safe(a) for a in addrs):
            return _URLBlock.PRIVATE_IP
        return None
    except Exception:
        return _URLBlock.DNS_FAIL


async def _is_safe_url(url: str) -> bool:
    """Bool 包装：用于重定向逐跳重校验（_safe_request）。"""
    return await _classify_url(url) is None


async def _safe_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    max_redirects: int = _MAX_REDIRECTS,
    **kwargs: Any,
) -> httpx.Response:
    """逐跳重校验的请求：每个重定向目标都重新过 SSRF 检查。

    client 必须以 follow_redirects=False 创建，否则 httpx 会自动跟随、
    使得「公网 URL 302 到内网 IP」绕过检查。命中拦截或超跳数则抛 ValueError。

    出网韧性（受限环境）：按原始请求主机做熔断——近期连续传输失败的主机会被
    临时短路（抛 EgressError 快速失败，不再空耗整个超时窗口）；传输失败计入熔断、
    成功则清零。仅传输层错误（连接/超时/网络）计数，HTTP 4xx/5xx 由调用方处理、
    不视为出网故障。
    """
    request = client.build_request(method, url, **kwargs)
    host = (request.url.host or "").lower()
    remaining = circuit_remaining(host)
    if remaining > 0:
        raise EgressError(
            f"站点 {host} 近期连续访问失败，已临时熔断约 {int(remaining)}s"
            "（出网受限或站点不可达），暂不重试"
        )
    for _ in range(max_redirects + 1):
        if not await _is_safe_url(str(request.url)):
            raise ValueError("URL blocked: private/internal network")
        try:
            resp = await client.send(request)
        except (httpx.TimeoutException, httpx.NetworkError):
            note_failure(host)
            raise
        nxt = resp.next_request
        if resp.is_redirect and nxt is not None:
            await resp.aclose()
            request = nxt
            continue
        note_success(host)
        return resp
    raise ValueError("Too many redirects")


class _TextExtractor(HTMLParser):
    """Minimal stdlib HTML→text extractor: drops scripts/styles, keeps the title,
    and inserts newlines at block boundaries (no third-party dependency)."""

    SKIP_TAGS = frozenset({"script", "style", "noscript", "svg", "head"})

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip_depth = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title:
            self.title = data.strip()
        if self._skip_depth == 0:
            self.parts.append(data)


def _extract_text(html: str, max_chars: int) -> tuple[str, str]:
    """Return ``(title, text)`` extracted from raw HTML, text capped to max_chars."""
    extractor = _TextExtractor()
    with contextlib.suppress(Exception):
        extractor.feed(html)
    raw = "".join(extractor.parts)
    text = re.sub(r"\n{3,}", "\n\n", raw).strip()[:max_chars]
    return extractor.title, text


class ReadUrlTool:
    """Fetch a web page and return its extracted main text."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="read_url",
            description=(
                "获取指定网页的正文文本（比 web_search 摘要更完整，但长页面会按 "
                "max_chars 截断），用于在 web_search 摘要不足、确需深读某条结果时。"
                "优先用 web_search 的摘要作答；仅在需要正文细节时才调用本工具。"
                "注意：部分大型站点（如百度百科、知乎等）有反爬保护，可能返回 403/失败——"
                "此时改用 web_search 摘要或换其他来源，不要对同一被拒站点反复重试。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要读取的网页 URL"},
                    "max_chars": {
                        "type": "integer",
                        "description": "返回的最大字符数，默认 8000",
                    },
                },
                "required": ["url"],
            },
            category=ToolCategory.RESEARCH,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        url = (arguments.get("url") or "").strip()
        if not url:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="缺少必填参数：url",
                duration_ms=0,
            )

        block = await _classify_url(url)
        if block is not None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=block.value,
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        try:
            raw_max = int(arguments.get("max_chars", _DEFAULT_MAX_CHARS))
            max_chars = max(1, min(raw_max, _MAX_CHARS_CAP))
        except (TypeError, ValueError):
            max_chars = _DEFAULT_MAX_CHARS

        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; AgentCore/1.0; +https://agentcore.dev)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        try:
            async with httpx.AsyncClient(timeout=web_timeout(), follow_redirects=False) as client:
                resp = await _safe_request(client, "GET", url, headers=headers)
                resp.raise_for_status()
                html = resp.text
        except Exception as e:
            reason = describe_net_error(e)
            logger.warning("tool.read_url_error", url=url, error=reason, error_repr=repr(e))
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"网页读取失败：{reason}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        title, text = _extract_text(html, max_chars)
        output = json.dumps({"url": url, "title": title, "content": text}, ensure_ascii=False)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=max_chars + 1024,
            metadata={"title": title, "content_chars": len(text)},
            citations=[{"url": url, "title": title, "snippet": "", "site": site_of(url)}],
        )
