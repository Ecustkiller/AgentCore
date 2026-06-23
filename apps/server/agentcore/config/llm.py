"""LLM provider, billing, and model-quality settings."""

from pydantic import BaseModel, computed_field


class LlmSettings(BaseModel):
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

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
