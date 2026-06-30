"""LLM provider, billing, and model-quality settings."""

from pydantic import BaseModel, computed_field


class LlmSettings(BaseModel):
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    # --- 多厂商 provider（OpenAI 兼容，经 ProviderRouter 按 provider/model 前缀路由） ---
    # 「真·多模型辩手」用：每家配 key 即解锁，空 key = 不注册（路由回退 DeepSeek）。base_url
    # 须含版本前缀（与各家 OpenAI 兼容文档一致）。前缀名见 llm/factory.build_router。
    moonshot_api_key: str = ""  # Kimi（前缀 kimi）
    moonshot_base_url: str = "https://api.moonshot.cn/v1"
    zhipu_api_key: str = ""  # 智谱 GLM（前缀 zhipu）
    zhipu_base_url: str = "https://open.bigmodel.cn/api/paas/v4"
    doubao_api_key: str = ""  # 豆包 / 火山方舟（前缀 doubao；model 传接入点 ID 或模型 ID）
    doubao_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"

    # --- AI 协作白板 读图 (AI协作白板.md §九.4) ---
    # 视觉 provider（Qwen-VL via DashScope OpenAI 兼容端点）。**空 key = 不启用**——`board_read`
    # 返回干净「读图能力未配置」错误；填 key 即「插上即用」，无需改任何代码。base_url 须含版本
    # 前缀（同各家 OpenAI 兼容文档）。内测期由运维/本机在 .env 配置（非 BYOK 逐用户）。
    vision_api_key: str = ""
    vision_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    vision_model: str = "qwen-vl-max"
    vision_timeout_seconds: float = 60.0

    # --- 计费模式 (BYOK 内测) ---
    billing_mode: str = "byok"

    # AES-256-GCM 主密钥，用于把 BYOK API Key 加密后落库。
    encryption_key: str = ""

    # --- Model quality modes (质量档, llm/modes.py) ---
    default_model_mode: str = "economy"
    user_selectable_models: str = "deepseek-v4-flash"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def selectable_models(self) -> frozenset[str]:
        """Operator ceiling: the set of models a user may pick in a custom mode."""
        return frozenset(m.strip() for m in self.user_selectable_models.split(",") if m.strip())
