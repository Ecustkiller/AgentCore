"""Platform LLM upstream, vendor keys, vision, and billing settings."""

from pydantic import BaseModel


class PlatformSettings(BaseModel):
    platform_api_key: str = ""
    platform_base_url: str = "https://api.deepseek.com"
    platform_model: str = "deepseek-v4-flash"
    # Background purposes (title/memory/compaction/followups); empty = follow platform_model.
    platform_background_model: str = ""

    # --- 多厂商 provider（OpenAI 兼容，经 ProviderRouter 按 provider/model 前缀路由） ---
    moonshot_api_key: str = ""
    moonshot_base_url: str = "https://api.moonshot.cn/v1"
    zhipu_api_key: str = ""
    zhipu_base_url: str = "https://open.bigmodel.cn/api/paas/v4"
    doubao_api_key: str = ""
    doubao_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"

    # --- AI 协作白板 读图 ---
    vision_api_key: str = ""
    vision_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    vision_model: str = "qwen-vl-max"
    vision_timeout_seconds: float = 60.0

    # --- 计费模式 ---
    billing_mode: str = "byok"
    # BYOK 部署下：无用户 key 时是否允许 fallback 到平台代付免费档（默认关）。
    platform_free_tier_enabled: bool = False

    # Sub2API 管理 API（可选）。配置后 platform 模式 503 时自动探测账号状态生成诊断。
    sub2api_admin_url: str = ""
    sub2api_admin_email: str = ""
    sub2api_admin_password: str = ""

    # AES-256-GCM 主密钥，用于把 BYOK API Key 加密后落库。
    encryption_key: str = ""
