import type { HostOpResult } from "@shared/host-contract";
import { parseJsonArray, runPowerShell } from "./powershell";
import { err, ok } from "./result";

async function hostStorageWin(): Promise<HostOpResult> {
  const ps = [
    "$ErrorActionPreference='Stop'",
    'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |',
    "  ForEach-Object {",
    "    [PSCustomObject]@{",
    "      device_id = $_.DeviceID",
    "      volume_name = $_.VolumeName",
    "      total_gb = [math]::Round(($_.Size / 1GB), 1)",
    "      free_gb = [math]::Round(($_.FreeSpace / 1GB), 1)",
    "      filesystem = $_.FileSystem",
    "    }",
    "  } | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  try {
    const raw = await runPowerShell(ps);
    const volumes = raw ? parseJsonArray(raw) : [];
    return ok({
      platform: "win32",
      volumes,
      note: "fixed_local_volumes_only",
    });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostStorageProbeError",
    );
  }
}

export async function hostStorage(): Promise<HostOpResult> {
  if (process.platform === "win32") {
    return hostStorageWin();
  }
  return ok({
    platform: process.platform,
    volumes: [],
    stub: true,
    note: "storage_probe_not_implemented_on_this_os",
  });
}
