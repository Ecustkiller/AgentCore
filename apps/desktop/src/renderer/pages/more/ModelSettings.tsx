import { Button, IconButton } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useModelModes } from "@/hooks/useModelModes";
import { hasLocalEngine } from "@/lib/capabilities";
import { ApiError } from "@/services/api";
import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setLlmKey,
  testLlmKey,
} from "@/services/llmKey";
import {
  modeLabel,
  presetLabel,
  setDefaultModelMode,
} from "@/services/modelModes";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import {
  Check,
  CheckCircle2,
  ChevronDown,
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

      <DefaultModelModeCard />

      {/* 本地引擎是桌面专属（web 无 sidecar，恒走云端）——web 不挂此开关。 */}
      {hasLocalEngine() && <LocalEngineToggle />}
    </div>
  );
}

/**
 * 默认质量档 (账户级) — the model tier every NEW conversation starts on (质量档
 * 选择器 · 账户默认档). Per-conversation overrides live in the composer's picker;
 * this sets the fallback. `null` = 跟随系统默认 (the operator default). Optimistic:
 * the label flips at once and reverts if the PUT fails.
 */
function DefaultModelModeCard() {
  const { data: modes, isLoading } = useModelModes();
  const current = useAuthStore((s) => s.user?.defaultModelMode ?? null);
  const setStoreDefault = useAuthStore((s) => s.setDefaultModelMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentLabel =
    current === null ? "跟随系统默认" : modeLabel(current, modes ?? null);

  const choose = async (next: string | null) => {
    if (next === current || saving) return;
    setSaving(true);
    setError(null);
    const prev = current;
    setStoreDefault(next);
    try {
      await setDefaultModelMode(next);
    } catch (e) {
      setStoreDefault(prev);
      setError(apiErrorMessage(e, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  const item = (
    active: boolean,
    label: string,
    onSelect: () => void,
    key: string,
  ) => (
    <DropdownMenuItem key={key} onSelect={onSelect}>
      <span className="flex-1 truncate">{label}</span>
      {active && <Check size={13} className="shrink-0" />}
    </DropdownMenuItem>
  );

  return (
    <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-foreground">默认质量档</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            新对话默认使用的模型档位；单个对话可在输入框临时切换。「高质」更强更贵，「经济」更快更省。
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isLoading || saving}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {currentLabel}
              <ChevronDown size={14} className="opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {item(
              current === null,
              "跟随系统默认",
              () => void choose(null),
              "__sys__",
            )}
            {modes && modes.presets.length > 0 && <DropdownMenuSeparator />}
            {modes?.presets.map((p) =>
              item(
                current === p.key,
                presetLabel(p.key),
                () => void choose(p.key),
                `preset:${p.key}`,
              ),
            )}
            {modes && modes.custom.length > 0 && <DropdownMenuSeparator />}
            {modes?.custom.map((m) =>
              item(
                current === m.id,
                m.name,
                () => void choose(m.id),
                `custom:${m.id}`,
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * 本地引擎（sidecar）开关（双模式工作区 §一.1）。开启后，绑定了本机本地文件夹的对话在用户
 * 电脑上直接运行（直连本地磁盘、文件/代码不再每 op 往返云端，更快），而非云端遥控桌面；裸聊与
 * 云端项目、带附件的回合仍走云。**默认开**、可关闭——启动失败会自动降级回云端（故默认开安全，
 * 见 `turns.sendTurn`）；但 sidecar 暂非真离线（推理仍经云端，断网不可用）（路由判定见
 * `services/sidecarRouting`）。
 */
function LocalEngineToggle() {
  const enabled = useUIStore((s) => s.sidecarEnabled);
  const setEnabled = useUIStore((s) => s.setSidecarEnabled);
  // 重新开启本地引擎时清掉本会话健康缓存：给上次因环境起不来被标坏、现已修好的根一次重新探活
  // 的机会（见 sidecarHealth）。关闭时无需清（不会再走 sidecar）。
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
            <IconButton
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "隐藏" : "显示"}
              className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </SimpleTooltip>
        </div>
        <Button
          size="md"
          className="shrink-0"
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
            className="shrink-0"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </Button>
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
