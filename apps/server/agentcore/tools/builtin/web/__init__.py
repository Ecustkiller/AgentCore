"""Web tools: ``web_search`` (via self-hosted SearXNG) + ``read_url`` (fetch +
extract) + ``download_url`` (HTTP(S) → workspace bytes). Direct-egress tools
share networking resilience from ``_net`` (per-host circuit breaker, honest
error messages, tuned timeouts) and the same SSRF policy as ``read_url``.
"""

from agentcore.tools.builtin.web.download_url import DownloadUrlTool
from agentcore.tools.builtin.web.read_url import ReadUrlTool
from agentcore.tools.builtin.web.search import WebSearchTool

__all__ = ["DownloadUrlTool", "ReadUrlTool", "WebSearchTool"]
