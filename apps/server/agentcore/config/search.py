"""Web search backend settings."""

from pydantic import BaseModel


class SearchSettings(BaseModel):
    searxng_url: str = "http://localhost:18888"
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"

    # PI-002 出网外泄硬守卫（默认关，仅观测）：开启后，read_url 对「本会话 web_search 未
    # surfaced 的新域名 + 携带较长查询参数」的请求直接拒绝（视为外泄信标），而非仅记
    # tool.read_url_novel_domain 告警日志。默认 False——只观测、不阻断，避免误伤用户直接
    # 粘贴或模型合法构造的长查询链接；运营方接受摩擦时再开。见 项目审计-提示注入专项 §五.
    read_url_block_novel_query: bool = False
