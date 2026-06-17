import { Switch } from "@/components/ui/Switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/services/api";
import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setLlmKey,
  testLlmKey,
} from "@/services/llmKey";
import { useUIStore } from "@/stores/ui";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsHeader } from "./SettingsHeader";

/**
 * 模型配置 (/more/model) — BYOK: the user's own DeepSeek API key.
 *
 * 内测期每条对话都跑在用户自己的 DeepSeek key 上（后端 config.billing_mode
 * "byok"）；没配 key 就不能发起对话（preflight 会拦下并引导到这里）。Key 以
 * AES-256-GCM 加密存储，服务端只回显后 4 位。这里可填写 / 更换 / 删除 key，并
 * 「测试连接」确认其可用（测试通过即代表真能跑）。
 */
export function ModelSettings() {
  const [status, setStatus] = useState<LlmKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    void getLlmKey()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setEditing(!s.configured); // unconfigured → open the input straight away
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
        description="填入你自己的 DeepSeek API Key，对话将使用你的额度运行。Key 经 AES 加密存储，仅回显后 4 位；未配置则无法发起对话。"
      />

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          加载中…
        </div>
      ) : loadError ? (
        <p className="mt-6 text-sm text-destructive">{loadError}</p>
      ) : (
        <div className="mt-6 space-y-4">
          {status?.configured && !editing && (
            <ConfiguredCard
              status={status}
              onChanged={setStatus}
              onReplace={() => setEditing(true)}
            />
          )}
          {editing && (
            <KeyForm
              configured={!!status?.configured}
              onSaved={(s) => {
                setStatus(s);
                setEditing(false);
              }}
              onCancel={
                status?.configured ? () => setEditing(false) : undefined
              }
            />
          )}
          <InfoNote />
        </div>
      )}

      <LocalEngineToggle />
    </div>
  );
}

/**
 * 本地引擎（sidecar）开关（双模式工作区 §一.1）。开启后，绑定了本机本地文件夹的对话在用户
 * 电脑上直接运行（直连本地磁盘、文件/代码不再每 op 往返云端，更快），而非云端遥控桌面；裸聊与
 * 云端项目、带附件的回合仍走云。默认关——sidecar 暂非真离线（推理仍经云端，断网不可用）、被
 * 委派 worker 强制走审批门，故先做成显式 opt-in 的实验能力（路由判定见 `services/sidecarRouting`）。
 */
function LocalEngineToggle() {
  const enabled = useUIStore((s) => s.sidecarEnabled);
  const setEnabled = useUIStore((s) => s.setSidecarEnabled);
  return (
    <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">本地引擎（实验）</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          开启后，绑定了本机本地文件夹的对话在你的电脑上运行（直连本地磁盘、更快），而非云端
          遥控。裸聊与云端项目仍走云；推理仍经云端，断网不可用。
        </p>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={setEnabled}
        label="本地引擎（实验）"
      />
    </div>
  );
}

/** Pull the server's error message out of an ApiError body, else a fallback. */
function apiErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    try {
      const body = JSON.parse(e.body) as { error?: { message?: string } };
      if (body.error?.message) return body.error.message;
    } catch {
      /* non-JSON body → fallback */
    }
  }
  return fallback;
}

/** External link to the DeepSeek platform; opens in the system browser
 *  (main process routes target=_blank through shell.openExternal). */
function DeepSeekLink({
  href,
  label,
  className = "",
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1 text-xs text-primary hover:underline ${className}`}
    >
      <ExternalLink size={14} />
      {label}
    </a>
  );
}

/** A status dot + label for the key's last connectivity result. */
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

/** The configured-key view: masked key + status + 测试连接 / 更换 / 删除. */
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
    if (!window.confirm("删除已保存的 API Key？删除后将无法发起对话。")) return;
    setRemoving(true);
    setActionError(null);
    try {
      await clearLlmKey();
      onChanged({
        configured: false,
        status: "unconfigured",
        masked_key: null,
      });
    } catch (e) {
      setActionError(apiErrorMessage(e, "删除失败，请重试"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-sm text-foreground">
            {status.masked_key ?? "已配置"}
          </p>
          <div className="mt-1">
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || removing}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            {testing && <Loader2 size={14} className="animate-spin" />}
            测试连接
          </button>
          <button
            type="button"
            onClick={onReplace}
            disabled={testing || removing}
            className="h-8 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            更换
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={testing || removing}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {removing && <Loader2 size={14} className="animate-spin" />}
            删除
          </button>
        </div>
      </div>
      {actionError && (
        <p className="mt-3 text-xs text-destructive">{actionError}</p>
      )}
      <div className="mt-3">
        <DeepSeekLink
          href="https://platform.deepseek.com/usage"
          label="查看用量/余额"
        />
      </div>
    </div>
  );
}

/** The input form for entering / replacing the key. */
function KeyForm({
  configured,
  onSaved,
  onCancel,
}: {
  configured: boolean;
  onSaved: (s: LlmKeyStatus) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = value.trim().length > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await setLlmKey(value.trim()));
    } catch (e) {
      setError(apiErrorMessage(e, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium text-foreground">
        {configured ? "更换 API Key" : "填写 DeepSeek API Key"}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-input bg-background pl-2 pr-9 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <SimpleTooltip label={reveal ? "隐藏" : "显示"}>
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "隐藏" : "显示"}
              className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </SimpleTooltip>
        </div>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          保存
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="h-8 shrink-0 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            取消
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <DeepSeekLink
        href="https://platform.deepseek.com/api_keys"
        label="前往 DeepSeek 开放平台创建 API Key"
        className="mt-3"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        创建后复制粘贴到上方输入框；保存后建议点「测试连接」确认可用。
      </p>
    </div>
  );
}

/** BYOK reassurance: encrypted at rest, your own quota, key never re-shown. */
function InfoNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <ShieldCheck
        size={16}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <p className="text-xs text-muted-foreground">
        你的 Key 仅用于你自己的对话，经 AES-256-GCM 加密存储，服务端只显示后 4
        位、不会回传完整内容。对话与后台任务（标题、记忆）都按你的 DeepSeek
        额度计费。
      </p>
    </div>
  );
}
