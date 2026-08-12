import { BrandMark } from "@/components/brand/BrandMark";
import { Button, Card } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import {
  hasAutoUpdater,
  hasLocalEngine,
  isWebRuntime,
} from "@/lib/capabilities";
import {
  clientGitSha,
  clientVersion,
  formatGitSha,
} from "@/lib/clientBuildInfo";
import { formatDownloadProgress } from "@/lib/format";
import {
  clientChannelLabelZh,
  clientReleaseChannel,
  desktopDownloadUrlForChannel,
  otherChannelDownloadLabel,
  otherChannelDownloadUrl,
} from "@/lib/releaseChannel";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { type VersionInfo, fetchVersion } from "@/services/system";
import { useUIStore } from "@/stores/ui";
import { useUpdatesStore } from "@/stores/updates";
import type { UpdaterStatus } from "@shared/updater-contract";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SettingsHeader } from "./SettingsHeader";

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <p className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-foreground" : "text-foreground"}>
        {value}
      </span>
    </p>
  );
}

/** Human-readable line for each updater phase (发布与门禁.md §7.6). */
function updateStatusText(status: UpdaterStatus): string {
  switch (status.phase) {
    case "idle":
      return "点击下方按钮检查是否有新版本。";
    case "unsupported":
      return "开发模式下不检查更新；自动更新仅在安装版中生效。";
    case "checking":
      return "正在检查更新…";
    case "not-available":
      return "已是最新版本。";
    case "available":
      return status.manualOnly
        ? `发现新版本 ${status.version}，此版本需手动下载安装。`
        : `发现新版本 ${status.version}，确认后开始后台下载。`;
    case "downloading":
      return `正在后台下载 ${status.version}…（${formatDownloadProgress({
        percent: status.percent,
        transferred: status.transferred,
        total: status.total,
        bytesPerSecond: status.bytesPerSecond,
      })}）`;
    case "downloaded":
      return `新版本 ${status.version} 已下载，重启后生效。`;
    case "error":
      return `更新失败：${status.message}`;
  }
}

/** 软件更新: mirror the main-process updater status + 检查 / 查看 / 重启安装. */
function UpdateSection() {
  const status = useUpdatesStore((s) => s.status);
  const check = useUpdatesStore((s) => s.check);
  const install = useUpdatesStore((s) => s.install);
  const openUpdateDialog = useUpdatesStore((s) => s.openUpdateDialog);

  const busy = status.phase === "checking" || status.phase === "downloading";
  const manualOnly = status.phase === "available" && Boolean(status.manualOnly);
  const downloadPageUrl = desktopDownloadUrlForChannel(clientReleaseChannel());

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="text-sm font-semibold text-foreground">软件更新</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {updateStatusText(status)}
      </p>
      {status.phase === "downloading" ? (
        <div className="mt-3 space-y-2">
          <progress
            className="h-2 w-full overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
            value={Math.min(100, status.percent)}
            max={100}
          />
          <Button
            variant="neutral"
            size="md"
            disabled
            icon={<Loader2 size={14} className="animate-spin" />}
          >
            下载中…
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status.phase === "downloaded" ? (
            <Button size="md" onClick={() => void install()}>
              重启安装
            </Button>
          ) : null}
          {manualOnly ? (
            <a
              href={downloadPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              前往下载页
            </a>
          ) : null}
          {status.phase === "available" ? (
            <Button
              size="md"
              variant={manualOnly ? "neutral" : "primary"}
              onClick={() => openUpdateDialog()}
            >
              查看更新
            </Button>
          ) : null}
          {status.phase !== "downloaded" && status.phase !== "available" ? (
            <Button
              variant="neutral"
              size="md"
              disabled={busy || status.phase === "unsupported"}
              icon={
                busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )
              }
              onClick={() => void check()}
            >
              检查更新
            </Button>
          ) : null}
          {status.phase === "available" ? (
            <Button
              variant="neutral"
              size="md"
              icon={<RefreshCw size={14} />}
              onClick={() => void check()}
            >
              重新检查
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * 诊断 / 强制关：本机传统项目新开回合默认同侧 sidecar；关 = 显式强制走云。
 * 展示用 `preference !== "off"`（unset 与 on 都算允许），勿绑 `sidecarEnabled`
 *（unset→默认 false，会显示关却仍默认同侧）。
 * 仅诊断模式开启且桌面有本地引擎时可见。
 */
function LocalEngineToggle() {
  const preference = useUIStore((s) => s.sidecarPreference);
  const setEnabled = useUIStore((s) => s.setSidecarEnabled);
  const allowed = preference !== "off";
  const onToggle = (v: boolean): void => {
    setEnabled(v);
    if (v) clearSidecarHealth();
  };
  return (
    <Card className="mt-4 flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">允许本机执行</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          诊断用强制走云：关闭后全部走云端过桥；开启则本机传统项目默认同侧引擎（与盘同侧）。启动失败会自动改走云。云端项目始终走云。这不是离线模式：AI
          推理仍在云端，断网时只能浏览缓存与本机文件（只读），不能发送。
        </p>
      </div>
      <Switch
        checked={allowed}
        onCheckedChange={onToggle}
        label="允许本机执行"
      />
    </Card>
  );
}

/**
 * 开发者 / 诊断模式 (前端UX设计.md §十) — advanced, off-by-default toggle that
 * surfaces low-level execution diagnostics in run detail (裸 run / trace ids、
 * 调度埋点等)。报障出口（错误卡 / 气泡「更多」→「复制排查包」）不依赖本开关。
 * Lives on 关于 — next to build 溯源 — so this stays off 大众-facing 偏好 pages.
 * 诊断开启且桌面有本地引擎时，附带「允许本机执行」强制关开关。
 */
function DiagnosticModeSection() {
  const diagnosticMode = useUIStore((s) => s.diagnosticMode);
  const setDiagnosticMode = useUIStore((s) => s.setDiagnosticMode);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            开发者 / 诊断模式
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            在运行详情里显示运行 / 追踪
            ID、调度埋点等底层信息。普通使用无需开启；报障请用错误卡或消息「更多」里的「复制排查包」（无需开本开关）。
          </p>
        </div>
        <Switch
          checked={diagnosticMode}
          onCheckedChange={setDiagnosticMode}
          label="开发者 / 诊断模式"
        />
      </div>
      {diagnosticMode && hasLocalEngine() ? <LocalEngineToggle /> : null}
    </section>
  );
}

export function AboutSettings() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchVersion();
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setError("获取版本信息失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="mb-8">
        <BrandMark size="md" className="text-foreground" />
        <p className="mt-4 text-base font-medium text-foreground">
          协作，是更高级的智能。
        </p>
        <p className="mt-1 text-sm text-muted-foreground">协作智能平台</p>
      </div>

      <SettingsHeader
        title="关于 AgentCore"
        description="版本信息与构建溯源。"
      />

      <div className="mt-6 space-y-2 text-sm">
        {loading ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : error ? (
          <p className="text-destructive">{error}</p>
        ) : info ? (
          <>
            <Row label="客户端版本" value={clientVersion()} />
            <Row
              label="客户端构建"
              value={formatGitSha(clientGitSha())}
              mono={clientGitSha() !== "unknown"}
            />
            {/* 桌面双轨：构建期通道；web 无并列安装身份，不展示。 */}
            {!isWebRuntime() ? (
              <Row label="更新通道" value={clientChannelLabelZh()} />
            ) : null}
            <Row label="API 版本" value={info.version} />
            <Row
              label="API 构建"
              value={formatGitSha(info.gitSha)}
              mono={info.gitSha !== "unknown"}
            />
            <Row
              label="API 构建时间"
              value={info.builtAt === "unknown" ? "—" : info.builtAt}
            />
          </>
        ) : null}
      </div>

      {/* 桌面：链到另一轨官网下载页（外链；不做同装热切 feed）。 */}
      {!isWebRuntime() ? (
        <p className="mt-3 text-sm">
          <a
            href={otherChannelDownloadUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline-offset-2 hover:underline"
          >
            {otherChannelDownloadLabel()}
          </a>
        </p>
      ) : null}

      {/* 自动更新仅桌面外壳；web 客户端随刷新拿到新版，故 web 不挂「软件更新」。 */}
      {hasAutoUpdater() && <UpdateSection />}

      <section className="mt-8 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">法律与合规</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          用户协议与隐私政策。
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link
            to={APP_PATHS.more.legal.terms}
            className="text-foreground underline-offset-2 hover:underline"
          >
            用户协议
          </Link>
          <Link
            to={APP_PATHS.more.legal.privacy}
            className="text-foreground underline-offset-2 hover:underline"
          >
            隐私政策
          </Link>
        </div>
      </section>

      <DiagnosticModeSection />
    </div>
  );
}
