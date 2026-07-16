import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type ByokProviderId,
  DEFAULT_BYOK_PROVIDER_ID,
  getByokProviderPreset,
  isCustomByokProvider,
  listByokProviderOptions,
  resolveByokProviderFromConfig,
} from "@/lib/byokProviderPresets";
import { ApiError } from "@/services/api";
import { type LlmKeyStatus, setLlmKey } from "@/services/llmKey";
import { ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { useId, useState } from "react";

export const MODEL_CONFIG_INPUT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

export function modelConfigApiErrorMessage(
  e: unknown,
  fallback: string,
): string {
  if (e instanceof ApiError) {
    try {
      const body = JSON.parse(e.body) as { error?: { message?: string } };
      if (body.error?.message) return body.error.message;
    } catch {
      /* non-JSON body */
    }
  }
  return fallback;
}

export type ModelKeyFormProps = {
  configured: boolean;
  initialBaseUrl: string;
  initialModel: string;
  /** Round-trip existing price card / background model on PUT (整表替换). */
  initialPriceCacheHit?: string | null;
  initialPriceCacheMiss?: string | null;
  initialPriceOutput?: string | null;
  initialBackgroundModel?: string | null;
  onSaved: (s: LlmKeyStatus) => void;
  onCancel?: () => void;
  /** Override primary CTA label (defaults: 保存 / 连接并继续). */
  submitLabel?: string;
  /** When true, hide the post-save「建议测试连接」hint (onboarding has its own wait UX). */
  hideTestHint?: boolean;
  /** Busy label while saving. */
  savingLabel?: string;
};

/**
 * BYOK 表单单一真相源 — 设置·模型配置与首启第二屏共用。
 * 厂商预设 → Key / Base URL / 默认模型；保存走 `setLlmKey`。
 */
export function ModelKeyForm({
  configured,
  initialBaseUrl,
  initialModel,
  initialPriceCacheHit = null,
  initialPriceCacheMiss = null,
  initialPriceOutput = null,
  initialBackgroundModel = null,
  onSaved,
  onCancel,
  submitLabel,
  hideTestHint = false,
  savingLabel = "保存中…",
}: ModelKeyFormProps) {
  const modelListId = useId();
  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState<ByokProviderId>(() =>
    resolveByokProviderFromConfig(initialBaseUrl),
  );
  const [baseUrl, setBaseUrl] = useState(() => {
    if (initialBaseUrl.trim()) return initialBaseUrl;
    return getByokProviderPreset(DEFAULT_BYOK_PROVIDER_ID).baseUrl;
  });
  const [defaultModel, setDefaultModel] = useState(() => {
    if (initialModel.trim()) return initialModel;
    return getByokProviderPreset(DEFAULT_BYOK_PROVIDER_ID).defaultModel;
  });
  const [priceCacheMiss, setPriceCacheMiss] = useState(
    () => initialPriceCacheMiss?.trim() ?? "",
  );
  const [priceOutput, setPriceOutput] = useState(
    () => initialPriceOutput?.trim() ?? "",
  );
  const [priceCacheHit, setPriceCacheHit] = useState(
    () => initialPriceCacheHit?.trim() ?? "",
  );
  const [backgroundModel, setBackgroundModel] = useState(
    () => initialBackgroundModel?.trim() ?? "",
  );
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = !isCustomByokProvider(providerId)
    ? getByokProviderPreset(providerId)
    : null;
  const modelSuggestions = preset?.models ?? [];
  const keyHelpUrl =
    preset?.keyHelpUrl ?? "https://platform.openai.com/api-keys";

  const selectProvider = (next: ByokProviderId) => {
    setProviderId(next);
    if (!isCustomByokProvider(next)) {
      const p = getByokProviderPreset(next);
      setBaseUrl(p.baseUrl);
      setDefaultModel(p.defaultModel);
    }
  };

  const canSave = apiKey.trim().length > 0 && !saving;
  const cta = submitLabel ?? (configured ? "保存" : "保存");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const miss = priceCacheMiss.trim();
      const out = priceOutput.trim();
      const hit = priceCacheHit.trim();
      // 输入+输出成对；全空=清除价卡。只填一侧时仍原样提交，由后端校验报错。
      const pricesEmpty = !miss && !out && !hit;
      onSaved(
        await setLlmKey({
          api_key: apiKey.trim(),
          base_url: baseUrl.trim() || null,
          default_model: defaultModel.trim() || null,
          price_cache_miss: pricesEmpty ? null : miss || null,
          price_output: pricesEmpty ? null : out || null,
          price_cache_hit: pricesEmpty ? null : hit || null,
          background_model: backgroundModel.trim() || null,
        }),
      );
    } catch (e) {
      setError(modelConfigApiErrorMessage(e, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium text-foreground">
        {configured ? "更换模型配置" : "填写模型配置"}
      </p>
      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs text-muted-foreground">厂商</span>
          <select
            value={providerId}
            onChange={(e) => selectProvider(e.target.value as ByokProviderId)}
            className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS} font-sans`}
          >
            {listByokProviderOptions().map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
          {!isCustomByokProvider(providerId) && (
            <p className="mt-1 text-xs text-muted-foreground">
              选择后将预填 Base URL 与常见模型；可按你的 Key 权限修改。
            </p>
          )}
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">API Key</span>
          <div className="relative mt-1">
            <input
              type={reveal ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className={`${MODEL_CONFIG_INPUT_CLASS} pl-2 pr-9`}
            />
            <SimpleTooltip label={reveal ? "隐藏" : "显示"}>
              <IconButton
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "隐藏" : "显示"}
                className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
              >
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
            </SimpleTooltip>
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Base URL</span>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              isCustomByokProvider(providerId)
                ? "https://your-endpoint.example/v1"
                : preset?.baseUrl
            }
            autoComplete="off"
            spellCheck={false}
            className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">默认模型名</span>
          <input
            type="text"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={
              isCustomByokProvider(providerId)
                ? "model-name"
                : preset?.defaultModel
            }
            list={modelSuggestions.length > 0 ? modelListId : undefined}
            autoComplete="off"
            spellCheck={false}
            className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
          />
          {modelSuggestions.length > 0 && (
            <datalist id={modelListId}>
              {modelSuggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          )}
        </label>
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-medium text-foreground">单价卡（可选）</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            USD / 1M tokens。输入与输出成对填写后，用量页与回合成本可显示 ≈¥
            估算；全空则清除价卡。
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">输入价</span>
              <input
                type="text"
                inputMode="decimal"
                value={priceCacheMiss}
                onChange={(e) => setPriceCacheMiss(e.target.value)}
                placeholder="如 0.28"
                autoComplete="off"
                spellCheck={false}
                className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">输出价</span>
              <input
                type="text"
                inputMode="decimal"
                value={priceOutput}
                onChange={(e) => setPriceOutput(e.target.value)}
                placeholder="如 0.42"
                autoComplete="off"
                spellCheck={false}
                className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                缓存命中价（可选）
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={priceCacheHit}
                onChange={(e) => setPriceCacheHit(e.target.value)}
                placeholder="缺省=输入价"
                autoComplete="off"
                spellCheck={false}
                className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
              />
            </label>
          </div>
        </div>
        <label className="block">
          <span className="text-xs text-muted-foreground">
            后台模型（可选）
          </span>
          <input
            type="text"
            value={backgroundModel}
            onChange={(e) => setBackgroundModel(e.target.value)}
            placeholder="留空跟随默认模型"
            autoComplete="off"
            spellCheck={false}
            className={`mt-1 ${MODEL_CONFIG_INPUT_CLASS}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            用于标题、记忆等后台任务的便宜模型，留空跟随默认模型
          </p>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="md"
          disabled={!canSave}
          icon={
            saving ? <Loader2 size={14} className="animate-spin" /> : undefined
          }
          onClick={() => void save()}
        >
          {saving ? savingLabel : cta}
        </Button>
        {onCancel && (
          <Button
            variant="neutral"
            size="md"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </Button>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <a
        href={keyHelpUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <ExternalLink size={14} />
        {isCustomByokProvider(providerId)
          ? "前往厂商控制台创建 API Key"
          : `前往 ${preset?.label ?? "厂商"} 创建 API Key`}
      </a>
      {!hideTestHint && (
        <p className="mt-2 text-xs text-muted-foreground">
          保存后建议点「测试连接」确认可用，并查看是否支持工具调用。
        </p>
      )}
    </div>
  );
}
