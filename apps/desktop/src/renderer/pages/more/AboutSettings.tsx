import { Button } from "@/components/ui";
import { type VersionInfo, fetchVersion } from "@/services/system";
import { useUpdatesStore } from "@/stores/updates";
import type { UpdaterStatus } from "@shared/updater-contract";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
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

/** Human-readable line for each updater phase (前端技术与架构.md §7.6). */
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
      return `发现新版本 ${status.version}，正在后台下载…`;
    case "downloading":
      return `正在下载新版本 ${status.version}…（${status.percent}%）`;
    case "downloaded":
      return `新版本 ${status.version} 已下载，重启后生效。`;
    case "error":
      return `更新检查失败：${status.message}`;
  }
}

/** 软件更新: mirror the main-process updater status + 检查 / 重启安装 actions. */
function UpdateSection() {
  const status = useUpdatesStore((s) => s.status);
  const check = useUpdatesStore((s) => s.check);
  const install = useUpdatesStore((s) => s.install);

  const busy =
    status.phase === "checking" ||
    status.phase === "available" ||
    status.phase === "downloading";

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="text-sm font-semibold text-foreground">软件更新</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {updateStatusText(status)}
      </p>
      <div className="mt-3">
        {status.phase === "downloaded" ? (
          <Button size="md" onClick={() => void install()}>
            重启安装
          </Button>
        ) : (
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
        )}
      </div>
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
            <Row label="版本" value={info.version} />
            <Row
              label="构建版本"
              value={
                info.gitSha === "unknown" ? "未标记（本地开发）" : info.gitSha
              }
              mono={info.gitSha !== "unknown"}
            />
            <Row
              label="构建时间"
              value={info.builtAt === "unknown" ? "—" : info.builtAt}
            />
          </>
        ) : null}
      </div>

      <UpdateSection />
    </div>
  );
}
