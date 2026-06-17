import { type VersionInfo, fetchVersion } from "@/services/system";
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
      <SettingsHeader title="关于 AgentCore" description="版本信息与构建溯源。" />

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
    </div>
  );
}
