import {
  type CreateLlmProviderInput,
  type LlmProviderView,
  type UpdateLlmProviderInput,
  createLlmProvider,
  updateLlmProvider,
} from "@/api/llmProviders";
import { useState } from "react";

// 添加 / 编辑一个 BYOK 服务商 (设置·模型配置). Mobile-local vendor presets (no shared package
// with desktop) prefill endpoint / label / connection-test model; 「自定义」also requires Base URL.
// Main path = vendor + name + Key（自定义另有 Base URL）.
// Advanced = Base URL override（预设）+ 连接测试用模型（Input + datalist 可选手填，仍提交 default_model）.
// Chat model pick lives in 模型组合, not this form.

/** Mobile-local BYOK presets. */
type ProviderId =
  | "deepseek"
  | "jiurelay"
  | "openai"
  | "moonshot"
  | "zhipu"
  | "doubao"
  | "hy"
  | "openrouter"
  | "opencode_zen"
  | "custom";

type ProviderPreset = {
  id: Exclude<ProviderId, "custom">;
  label: string;
  baseUrl: string;
  baseUrlAliases?: readonly string[];
  defaultModel: string;
  /** Common model IDs for the preset datalist (aligned with desktop byokProviderPresets). */
  models: readonly string[];
};

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    baseUrlAliases: ["https://api.deepseek.com/v1"],
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "jiurelay",
    label: "JiuRelay",
    baseUrl: "https://jiurelay.com/openai/v1",
    defaultModel: "glm-5.2",
    models: ["glm-5.2", "deepseek-v4-flash-0731", "grok-4.5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  {
    id: "moonshot",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    baseUrlAliases: ["https://api.moonshot.ai/v1"],
    defaultModel: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-k3", "kimi-k2.5"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    models: ["glm-4-plus", "glm-4-flash", "glm-4-air"],
  },
  {
    id: "doubao",
    label: "豆包 (火山方舟)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-2-1-turbo-260628",
    // Short seed; doubao-pro-32k / doubao-lite-32k retired — use dated seed IDs or ep-… endpoints.
    models: ["doubao-seed-2-1-turbo-260628"],
  },
  {
    id: "hy",
    label: "腾讯 Hy (TokenHub)",
    // Domestic Guangzhou canonical; .cn backup + intl hosts match-only aliases.
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    baseUrlAliases: [
      "https://tokenhub.tencentmaas.cn/v1",
      "https://tokenhub-intl.tencentmaas.com/v1",
      "https://tokenhub-intl.tencentmaas.cn/v1",
    ],
    defaultModel: "hy3",
    models: ["hy3", "hy3-preview"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    models: [
      "openrouter/auto",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
    ],
  },
  {
    id: "opencode_zen",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "deepseek-v4-flash",
    // Short seed for discovery-miss; full catalog = GET /models union.
    models: ["deepseek-v4-flash", "kimi-k2.6", "glm-5.2"],
  },
];

const DEFAULT_PROVIDER_ID: Exclude<ProviderId, "custom"> = "deepseek";

const MODEL_DATALIST_ID = "llm-default-model-suggestions";

function normalizeBaseUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resolveProvider(baseUrl: string): ProviderId {
  const trimmed = baseUrl.trim();
  if (!trimmed) return DEFAULT_PROVIDER_ID;
  const normalized = normalizeBaseUrl(trimmed);
  for (const preset of PROVIDER_PRESETS) {
    const candidates = [preset.baseUrl, ...(preset.baseUrlAliases ?? [])];
    if (candidates.some((c) => normalizeBaseUrl(c) === normalized)) {
      return preset.id;
    }
  }
  return "custom";
}

function getPreset(id: Exclude<ProviderId, "custom">): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown provider: ${id}`);
  return preset;
}

function isListedModel(preset: ProviderPreset, model: string): boolean {
  return preset.models.includes(model);
}

/**
 * When switching vendor presets: empty / still the old default → new default;
 * value in the new preset's models → keep; otherwise keep the custom value.
 */
function nextModelAfterPresetSwitch(
  currentModel: string,
  prev: ProviderPreset | null,
  next: ProviderPreset,
): string {
  const current = currentModel.trim();
  if (!current || (prev != null && current === prev.defaultModel)) {
    return next.defaultModel;
  }
  if (next.models.includes(current)) return current;
  return current;
}

export function ProviderForm({
  provider,
  onSaved,
  onCancel,
}: {
  /** When set, the form edits this provider; otherwise it adds a new one. */
  provider?: LlmProviderView;
  /** Called after a successful create/update (parent reloads the authoritative list). */
  onSaved: (saved: LlmProviderView) => void;
  onCancel: () => void;
}) {
  const editing = provider != null;
  const defaultPreset = getPreset(DEFAULT_PROVIDER_ID);
  const initialBaseUrl = provider?.base_url ?? "";
  const initialModel = provider?.default_model ?? "";

  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState<ProviderId>(() =>
    editing ? resolveProvider(initialBaseUrl) : DEFAULT_PROVIDER_ID,
  );
  const [label, setLabel] = useState(
    () => provider?.label ?? defaultPreset.label,
  );
  const [baseUrl, setBaseUrl] = useState(
    () => initialBaseUrl.trim() || defaultPreset.baseUrl,
  );
  const [defaultModel, setDefaultModel] = useState(
    () => initialModel.trim() || defaultPreset.defaultModel,
  );
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = providerId === "custom";
  const preset = isCustom ? null : getPreset(providerId);

  const baseUrlOverride =
    !isCustom &&
    preset != null &&
    baseUrl.trim().length > 0 &&
    normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(preset.baseUrl) &&
    !(preset.baseUrlAliases ?? []).some(
      (alias) => normalizeBaseUrl(alias) === normalizeBaseUrl(baseUrl),
    );
  const initialNonListedModel = (() => {
    if (!editing) return false;
    const id = resolveProvider(initialBaseUrl);
    if (id === "custom") return false;
    const model = initialModel.trim();
    if (!model) return false;
    return !isListedModel(getPreset(id), model);
  })();
  const [advancedOpen, setAdvancedOpen] = useState(
    () => baseUrlOverride || initialNonListedModel,
  );

  const keyOk = editing || apiKey.trim().length > 0;
  const canSave =
    keyOk &&
    baseUrl.trim().length > 0 &&
    defaultModel.trim().length > 0 &&
    !saving;

  function selectProvider(next: ProviderId) {
    const prev = providerId === "custom" ? null : getPreset(providerId);
    setProviderId(next);
    if (next !== "custom") {
      const p = getPreset(next);
      setBaseUrl(p.baseUrl);
      setLabel(p.label);
      setDefaultModel(nextModelAfterPresetSwitch(defaultModel, prev, p));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const trimmedKey = apiKey.trim();
      const common = {
        base_url: baseUrl.trim() || null,
        default_model: defaultModel.trim() || null,
        label: label.trim(),
      };
      let saved: LlmProviderView;
      if (editing && provider) {
        const patch: UpdateLlmProviderInput = { ...common };
        // 编辑时留空 = 保留已存密文（省略 api_key）。
        if (trimmedKey) patch.api_key = trimmedKey;
        saved = await updateLlmProvider(provider.id, patch);
      } else {
        const body: CreateLlmProviderInput = {
          api_key: trimmedKey,
          ...common,
        };
        saved = await createLlmProvider(body);
      }
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section-card">
      <span className="section-title">
        {editing ? "编辑服务商" : "添加服务商"}
      </span>

      <div className="field">
        <label className="field-label" htmlFor="llm-provider">
          厂商
        </label>
        <select
          id="llm-provider"
          value={providerId}
          onChange={(e) => selectProvider(e.target.value as ProviderId)}
          className="text-input"
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
        {!isCustom && (
          <p className="section-note" style={{ marginTop: 4 }}>
            选择后将预填名称与端点；日常选用请到「模型组合」。
          </p>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="llm-label">
          显示名称
        </label>
        <input
          id="llm-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="如 DeepSeek、火山方舟"
          autoComplete="off"
          spellCheck={false}
          className="text-input"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="llm-api-key">
          API Key{editing ? "（可选）" : ""}
        </label>
        <div className="key-input-wrap">
          <input
            id="llm-api-key"
            type={reveal ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? "留空则保留已保存的 Key" : "sk-..."}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="key-reveal"
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? "隐藏" : "显示"}
          </button>
        </div>
      </div>

      {isCustom && (
        <div className="field">
          <label className="field-label" htmlFor="llm-base-url">
            Base URL
          </label>
          <input
            id="llm-base-url"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-endpoint.example/v1"
            autoComplete="off"
            spellCheck={false}
            className="text-input"
          />
          <p className="section-note" style={{ marginTop: 4 }}>
            须为 AgentCore
            云端可访问的公网地址；公司内网域名通常不可用。自定义地址通常需含
            /v1（例 https://api.example.com/v1）。
          </p>
        </div>
      )}

      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="field-label" style={{ cursor: "pointer" }}>
          高级选项
        </summary>
        {!isCustom && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label" htmlFor="llm-base-url">
              Base URL
            </label>
            <input
              id="llm-base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset?.baseUrl}
              autoComplete="off"
              spellCheck={false}
              className="text-input"
            />
            <p className="section-note" style={{ marginTop: 4 }}>
              须为 AgentCore
              云端可访问的公网地址；公司内网域名通常不可用。自定义地址通常需含
              /v1（例 https://api.example.com/v1）。
            </p>
          </div>
        )}
        <div className="field" style={{ marginTop: 8 }}>
          <label className="field-label" htmlFor="llm-default-model">
            连接测试用模型
          </label>
          <input
            id="llm-default-model"
            type="text"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={preset?.defaultModel ?? "model-name"}
            list={!isCustom && preset != null ? MODEL_DATALIST_ID : undefined}
            autoComplete="off"
            spellCheck={false}
            className="text-input"
          />
          {!isCustom && preset != null && (
            <datalist id={MODEL_DATALIST_ID}>
              {preset.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
          {providerId === "jiurelay" && (
            <p className="section-note" style={{ marginTop: 4 }}>
              领取的 Key 须与所选模型对应
            </p>
          )}
          <p className="section-note" style={{ marginTop: 4 }}>
            可直接粘贴模型 ID；连接测试与目录兜底用。日常选用请到「模型组合」。
          </p>
        </div>
      </details>

      <div className="field-actions">
        <button
          type="button"
          className="btn-outline"
          onClick={onCancel}
          disabled={saving}
        >
          取消
        </button>
        <button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
