import { ToolsCapabilityBadge } from "@/components/llm/ToolsCapabilityBadge";
import { Button, IconButton } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type ByokProviderId,
  DEFAULT_BYOK_PROVIDER_ID,
  getByokProviderPreset,
  isCustomByokProvider,
  listByokProviderOptions,
  resolveByokProviderFromConfig,
} from "@/lib/byokProviderPresets";
import { hasLocalEngine } from "@/lib/capabilities";
import { llmKeyKeys } from "@/lib/queryKeys";
import { ApiError } from "@/services/api";
import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setLlmKey,
  testLlmKey,
} from "@/services/llmKey";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { useUIStore } from "@/stores/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SettingsHeader } from "./SettingsHeader";

const INPUT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * 模型配置 (/more/model) — BYOK OpenAI-compatible endpoint.
 *
 * 内测期用户侧仅暴露自带 Key；平台免费额度入口暂隐藏（后端路径保留）。
 */
export function ModelSettings() {
  const [status, setStatus] = useState<LlmKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const syncStatus = (next: LlmKeyStatus) => {
    setStatus(next);
    queryClient.setQueryData(llmKeyKeys.status, next);
  };

  useEffect(() => {
    let alive = true;
    void getLlmKey()
      .then((s) => {
        if (!alive) return;
        syncStatus(s);
        setEditing(!s.configured);
      })
      .catch(() => alive && setLoadError("加载失败，请重试"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <SettingsHeader
        title="模型配置"
        description="配置 OpenAI 兼容端点（API Key、Base URL、默认模型名）。Key 经 AES 加密存储，仅回显后 4 位；未配置则无法发起对话。"
      />

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          加载中…
        </div>
      ) : loadError ? (
        <p className="mt-6 text-sm text-destructive">{loadError}</p>
      ) : status ? (
        <div className="mt-6 space-y-4">
          {status.configured && !editing && (
            <ConfiguredCard
              status={status}
              onChanged={syncStatus}
              onReplace={() => setEditing(true)}
            />
          )}
          {editing && (
            <KeyForm
              configured={!!status.configured}
              initialBaseUrl={status.base_url ?? ""}
              initialModel={status.default_model ?? ""}
              onSaved={(s) => {
                syncStatus(s);
                setEditing(false);
              }}
              onCancel={status.configured ? () => setEditing(false) : undefined}
            />
          )}
          <InfoNote />
        </div>
      ) : null}

      {hasLocalEngine() && <LocalEngineToggle />}
    </div>
  );
}

function apiErrorMessage(e: unknown, fallback: string): string {
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

function StatusBadge({ status }: { status: LlmKeyStatus }) {
  if (status.status === "active") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-success">
        <CheckCircle2 size={14} />
        连接正常
      </span>
    );
  }
  if (status.status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <XCircle size={14} />
        {status.message ?? "连接失败"}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">未测试</span>;
}

function ConfiguredCard({
  status,
  onChanged,
  onReplace,
}: {
  status: LlmKeyStatus;
  onChanged: (s: LlmKeyStatus) => void;
  onReplace: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setActionError(null);
    try {
      onChanged(await testLlmKey());
    } catch (e) {
      setActionError(apiErrorMessage(e, "测试失败，请重试"));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("删除已保存的模型配置？删除后将无法发起对话。")) return;
    setRemoving(true);
    setActionError(null);
    try {
      await clearLlmKey();
      onChanged({
        configured: false,
        status: "unconfigured",
        masked_key: null,
        billing_mode: status.billing_mode,
        billing_preference: status.billing_preference,
        platform_available: status.platform_available,
      });
    } catch (e) {
      setActionError(apiErrorMessage(e, "删除失败，请重试"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-sm text-foreground">
            {status.masked_key ?? "已配置"}
          </p>
          {status.base_url && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {status.base_url}
            </p>
          )}
          {status.default_model && (
            <p className="font-mono text-xs text-foreground">
              模型 {status.default_model}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <StatusBadge status={status} />
            <ToolsCapabilityBadge supportsTools={status.supports_tools} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
          <Button
            variant="neutral"
            size="md"
            disabled={testing || removing}
            icon={
              testing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : undefined
            }
            onClick={() => void test()}
          >
            测试连接
          </Button>
          <Button
            variant="neutral"
            size="md"
            disabled={testing || removing}
            onClick={onReplace}
          >
            更换
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={testing || removing}
            icon={
              removing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : undefined
            }
            onClick={() => void remove()}
          >
            删除
          </Button>
        </div>
      </div>
      {actionError && (
        <p className="mt-3 text-xs text-destructive">{actionError}</p>
      )}
    </div>
  );
}

function KeyForm({
  configured,
  initialBaseUrl,
  initialModel,
  onSaved,
  onCancel,
}: {
  configured: boolean;
  initialBaseUrl: string;
  initialModel: string;
  onSaved: (s: LlmKeyStatus) => void;
  onCancel?: () => void;
}) {
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

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await setLlmKey({
          api_key: apiKey.trim(),
          base_url: baseUrl.trim() || null,
          default_model: defaultModel.trim() || null,
        }),
      );
    } catch (e) {
      setError(apiErrorMessage(e, "保存失败，请重试"));
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
            className={`mt-1 ${INPUT_CLASS} font-sans`}
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
              className={`${INPUT_CLASS} pl-2 pr-9`}
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
            className={`mt-1 ${INPUT_CLASS}`}
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
            className={`mt-1 ${INPUT_CLASS}`}
          />
          {modelSuggestions.length > 0 && (
            <datalist id={modelListId}>
              {modelSuggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          )}
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
          保存
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
      <p className="mt-2 text-xs text-muted-foreground">
        保存后建议点「测试连接」确认可用，并查看是否支持工具调用。
      </p>
    </div>
  );
}

function LocalEngineToggle() {
  const enabled = useUIStore((s) => s.sidecarEnabled);
  const setEnabled = useUIStore((s) => s.setSidecarEnabled);
  const onToggle = (v: boolean): void => {
    setEnabled(v);
    if (v) clearSidecarHealth();
  };
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">本地引擎</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          绑定本机本地文件夹的对话默认在你的电脑上运行（直连本地磁盘、更快），启动失败会自动切回
          云端。裸聊与云端项目仍走云；AI
          推理仍在云端，断网时不可用。关闭后全部走云端。
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={onToggle} label="本地引擎" />
    </div>
  );
}

function InfoNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <ShieldCheck
        size={16}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <p className="text-xs text-muted-foreground">
        你的 Key 仅用于你自己的对话，经 AES-256-GCM 加密存储，服务端只显示后 4
        位、不会回传完整内容。聊天、委派、辩论均使用此处配置的同一模型；平台只统计
        token 用量、不代为计价。
      </p>
    </div>
  );
}
