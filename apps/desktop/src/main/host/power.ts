import type { HostOpResult } from "@shared/host-contract";
import { runPowerShell } from "./powershell";
import { err, ok } from "./result";

async function hostPowerWin(): Promise<HostOpResult> {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$batteries = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue |",
    "  ForEach-Object {",
    "    [PSCustomObject]@{",
    "      name = $_.Name",
    "      estimated_charge_remaining = $_.EstimatedChargeRemaining",
    "      battery_status = $_.BatteryStatus",
    "      estimated_run_time_min = $_.EstimatedRunTime",
    "    }",
    "  })",
    "$onAc = $batteries.Count -eq 0 -or ($batteries | Where-Object {",
    "  $_.battery_status -in @(2, 6, 7, 8, 9)",
    "} | Measure-Object).Count -gt 0",
    "[PSCustomObject]@{",
    "  on_ac = [bool]$onAc",
    "  batteries = $batteries",
    "  note = $(if ($batteries.Count -eq 0) { 'no_battery_or_desktop' } else { 'win32_battery' })",
    "} | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  try {
    const raw = await runPowerShell(ps);
    if (!raw) {
      return ok({
        platform: "win32",
        on_ac: true,
        batteries: [],
        note: "no_battery_or_desktop",
      });
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ok({ platform: "win32", ...parsed });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostPowerProbeError",
    );
  }
}

export async function hostPower(): Promise<HostOpResult> {
  if (process.platform === "win32") {
    return hostPowerWin();
  }
  return ok({
    platform: process.platform,
    on_ac: null,
    batteries: [],
    stub: true,
    note: "power_probe_not_implemented_on_this_os",
  });
}
