"""Knowledge-layer retrieval settings (生成 / 最后修订 2026-11-04).

上游《Agent记忆与知识系统》「否决」表明确否决「向量 chunk 自动灌 prompt」：
与「文件随时变」不合，agentic 自取永远新鲜。所以本 fork 的 #4 只提供
**按需检索**（人侧查一次 / 模型主动调一次工具），结果只在该次调用里可见，
绝不自动进每一回合的 prompt，也不引入 embedding 服务或向量库。

两个开关分开：
- ``knowledge_search_enabled`` 控制**模型工具面**（默认关）——给模型加工具会
  改变公开能力目录和开场表，按本 fork 原则不覆盖上游默认行为。
- HTTP 端点只读、owner-scoped、无副作用，恒开；人随时可查，与工具面无关。
"""

from pydantic import BaseModel, Field


class KnowledgeSettings(BaseModel):
    # 默认关：既不改工具名册，也不改能力目录与开场 FC 表。
    knowledge_search_enabled: bool = False

    knowledge_search_max_results: int = Field(default=8, ge=1, le=20)
    knowledge_search_snippet_radius: int = Field(default=120, ge=20, le=400)
    # SQL 先按更新时间取候选，再在 Python 侧重排相关度；这个倍数决定候选池大小。
    knowledge_search_candidate_multiplier: int = Field(default=4, ge=1, le=10)
