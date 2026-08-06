import type { HostOpResult } from "@shared/host-contract";
import { runPowerShell } from "./powershell";
import { err, ok } from "./result";

const APPS_SAMPLE_LIMIT = 30;

async function hostAppsWin(): Promise<HostOpResult> {
  // Bounded Start Menu .lnk sample — not a full uninstall registry dump.
  const ps = [
    `$limit = ${APPS_SAMPLE_LIMIT}`,
    "$ErrorActionPreference='SilentlyContinue'",
    "$dirs = @(",
    '  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",',
    '  "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs"',
    ")",
    "$names = New-Object System.Collections.Generic.HashSet[string]",
    "foreach ($d in $dirs) {",
    "  if (-not (Test-Path -LiteralPath $d)) { continue }",
    "  Get-ChildItem -LiteralPath $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |",
    "    ForEach-Object { [void]$names.Add($_.BaseName) }",
    "}",
    "$sorted = $names | Sort-Object",
    "[PSCustomObject]@{",
    "  count = @($sorted).Count",
    "  sample = @($sorted | Select-Object -First $limit)",
    "  sample_limit = $limit",
    "  source = 'start_menu_lnk'",
    "  bounded = $true",
    "} | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  try {
    const raw = await runPowerShell(ps, 20_000);
    if (!raw) {
      return ok({
        platform: "win32",
        count: 0,
        sample: [],
        sample_limit: APPS_SAMPLE_LIMIT,
        source: "start_menu_lnk",
        bounded: true,
        note: "no_start_menu_entries",
      });
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ok({ platform: "win32", ...parsed });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostAppsProbeError",
    );
  }
}

export async function hostApps(): Promise<HostOpResult> {
  if (process.platform === "win32") {
    return hostAppsWin();
  }
  // Honest stub — do not invent installed-app lists.
  return ok({
    platform: process.platform,
    count: 0,
    sample: [],
    sample_limit: APPS_SAMPLE_LIMIT,
    source: "stub",
    bounded: true,
    stub: true,
    note: "apps_probe_not_implemented_on_this_os",
  });
}
