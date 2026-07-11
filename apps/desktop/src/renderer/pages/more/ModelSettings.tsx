import {
  ModelKeyForm,
  modelConfigApiErrorMessage,
} from "@/components/llm/ModelKeyForm";
import { ToolsCapabilityBadge } from "@/components/llm/ToolsCapabilityBadge";
import { Button } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import {
  getByokProviderPreset,
  isCustomByokProvider,
  resolveByokProviderFromConfig,
} from "@/lib/byokProviderPresets";
import { hasLocalEngine } from "@/lib/capabilities";
import { llmKeyKeys } from "@/lib/queryKeys";
import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setBillingPreference,
  testLlmKey,
} from "@/services/llmKey";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { useUIStore } from "@/stores/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SettingsHeader } from "./SettingsHeader";
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

  const syncStatus = useCallback(
    (next: LlmKeyStatus) => {
      setStatus(next);
      queryClient.setQueryData(llmKeyKeys.status, next);
    },
    [queryClient],
  );

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
  }, [syncStatus]);

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
          {status.platform_available && (
            <ModelSourceToggle status={status} onChanged={syncStatus} />
          )}
          {status.configured && !editing && (
            <ConfiguredCard
              status={status}
              onChanged={syncStatus}
              onReplace={() => setEditing(true)}
            />
          )}
          {editing && (
            <ModelKeyForm
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

/**
 * 模型来源切换（自带 Key / 平台模型）—— 暴露既有的 `billing-preference` 后端能力：
 * platform ⇒ 用运营方平台模型（如 gpt-5.5）、byok ⇒ 用下方配置的自带 Key（如 deepseek-…）。
 * 只在平台可用时出现（否则无「另一个」可切）。切换后 `onChanged` 刷新状态缓存，输入框徽标随之更新。
 */
function ModelSourceToggle({
  status,
  onChanged,
}: {
  status: LlmKeyStatus;
  onChanged: (s: LlmKeyStatus) => void;
}) {
  const [switching, setSwitching] = useState<"platform" | "byok" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = status.billing_preference;

  // 自带 Key 那侧的副标题：优先展示真实的自带模型名（byok_model，即便当前跑在平台、也能显示），
  // 拿不到时退回按 base_url 认出的厂商名 / 「未配置」。平台那侧固定显示平台模型名。
  const byokProviderId = status.base_url
    ? resolveByokProviderFromConfig(status.base_url)
    : null;
  const byokProviderLabel =
    byokProviderId === null
      ? status.configured
        ? "已配置"
        : "未配置"
      : isCustomByokProvider(byokProviderId)
        ? "自定义"
        : getByokProviderPreset(byokProviderId).label;
  const byokLabel = status.byok_model?.trim() || byokProviderLabel;
  const platformLabel = status.platform_model?.trim() || "平台模型";

  const choose = async (pref: "platform" | "byok") => {
    if (pref === current || switching) return;
    setSwitching(pref);
    setError(null);
    try {
      onChanged(await setBillingPreference(pref));
    } catch (e) {
      setError(modelConfigApiErrorMessage(e, "切换失败，请重试"));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium text-foreground">模型来源</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        选择对话使用哪个模型：自带 Key
        用你下方配置的模型，平台模型用运营方提供的模型。切换即时生效，只影响之后的新回合。
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <SourceOption
          active={current === "byok"}
          busy={switching === "byok"}
          disabled={switching !== null}
          title="自带 Key"
          subtitle={byokLabel}
          onClick={() => void choose("byok")}
        />
        <SourceOption
          active={current === "platform"}
          busy={switching === "platform"}
          disabled={switching !== null}
          title="平台模型"
          subtitle={platformLabel}
          onClick={() => void choose("platform")}
        />
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function SourceOption({
  active,
  busy,
  disabled,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  busy: boolean;
  disabled: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : "border-input bg-background hover:bg-muted"
      } ${disabled && !active ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : active ? (
          <CheckCircle2 size={12} className="text-primary" />
        ) : null}
        {title}
      </span>
      <span className="w-full truncate font-mono text-xs text-muted-foreground">
        {subtitle}
      </span>
    </button>
  );
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
      setActionError(modelConfigApiErrorMessage(e, "测试失败，请重试"));
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
      setActionError(modelConfigApiErrorMessage(e, "删除失败，请重试"));
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
          {status.byok_model && (
            <p className="font-mono text-xs text-foreground">
              模型 {status.byok_model}
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
