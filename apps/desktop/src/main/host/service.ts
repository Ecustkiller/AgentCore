import type { HostOpResult } from "@shared/host-contract";
import { runPowerShell } from "./powershell";
import { err, ok } from "./result";

/** L3 service-name whitelist — keep closed (Host 定案 P2). Canonical SCM names only. */
const SERVICE_RESTART_ALLOWLIST = new Set(["audiosrv"]);

async function restartServiceWin(service: string): Promise<HostOpResult> {
  // Restart-Service only — never arbitrary sc stop / start of non-allowlisted names.
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$name = '${service.replace(/'/g, "''")}'`,
    "Restart-Service -Name $name -Force -ErrorAction Stop",
    "$svc = Get-Service -Name $name",
    "[PSCustomObject]@{ restarted = $true; service = $svc.Name; status = [string]$svc.Status } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const raw = await runPowerShell(ps, 45_000);
    if (!raw) {
      return ok({
        platform: "win32",
        restarted: true,
        service,
        status: "unknown",
      });
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ok({ platform: "win32", ...parsed });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostServiceRestartError",
    );
  }
}

export async function restartService(
  serviceRaw: string,
): Promise<HostOpResult> {
  const service = serviceRaw.trim();
  if (!service) return err("service is required");
  if (!SERVICE_RESTART_ALLOWLIST.has(service.toLowerCase())) {
    return err(
      `service not in allowlist: ${service} (only Audiosrv)`,
      "HostServiceNotAllowlisted",
    );
  }
  // Canonical SCM name.
  const canonical = "Audiosrv";
  if (process.platform === "win32") {
    return restartServiceWin(canonical);
  }
  return err(
    `host_service_restart not implemented on ${process.platform}`,
    "HostServiceRestartStub",
  );
}
