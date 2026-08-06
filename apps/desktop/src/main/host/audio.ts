import type { HostOpResult } from "@shared/host-contract";
import {
  parseJsonArray,
  runPowerShell,
  runPowerShellEncoded,
} from "./powershell";
import { err, ok } from "./result";

async function listAudioDevicesWin(): Promise<HostOpResult> {
  // Prefer AudioEndpoint PnP names (playback/capture). Fallback to Win32_SoundDevice.
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$eps = Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue |",
    "  Select-Object -Property FriendlyName, InstanceId",
    "if ($eps) {",
    "  $eps | ForEach-Object {",
    "    [PSCustomObject]@{ name=$_.FriendlyName; id=$_.InstanceId; kind='endpoint' }",
    "  } | ConvertTo-Json -Compress -Depth 3",
    "} else {",
    "  Get-CimInstance Win32_SoundDevice |",
    "    Select-Object -Property Name, DeviceID, Status |",
    "    ForEach-Object {",
    "      [PSCustomObject]@{ name=$_.Name; id=$_.DeviceID; status=$_.Status; kind='sound_device' }",
    "    } | ConvertTo-Json -Compress -Depth 3",
    "}",
  ].join("; ");
  try {
    const raw = await runPowerShell(ps);
    if (!raw) {
      return ok({ platform: "win32", devices: [], note: "no_audio_devices" });
    }
    return ok({ platform: "win32", devices: parseJsonArray(raw) });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostAudioProbeError",
    );
  }
}

export async function listAudioDevices(): Promise<HostOpResult> {
  if (process.platform === "win32") {
    return listAudioDevicesWin();
  }
  return ok({
    platform: process.platform,
    devices: [],
    stub: true,
    note: "audio_device_probe_not_implemented_on_this_os",
  });
}

type AudioDeviceRow = {
  name?: string;
  id?: string;
  kind?: string;
  status?: string;
};

function asDeviceRows(value: Record<string, unknown>): AudioDeviceRow[] {
  const devices = value.devices;
  if (!Array.isArray(devices)) return [];
  return devices.filter(
    (d): d is AudioDeviceRow =>
      !!d && typeof d === "object" && !Array.isArray(d),
  ) as AudioDeviceRow[];
}

/** Map PnP AudioEndpoint InstanceId → Core Audio device id for PolicyConfig. */
function toMmDeviceId(rawId: string): string | null {
  const id = rawId.trim();
  if (!id) return null;
  // Already a Core Audio id: {0.0.0.00000000}.{guid}
  if (/^\{0\.0\.[01]\.00000000\}\./i.test(id)) return id;
  const m = id.match(/\{0\.0\.[01]\.00000000\}\.\{[0-9a-fA-F-]+\}/i);
  return m ? m[0] : null;
}

function isPlaybackEndpointId(mmId: string): boolean {
  // Render = 0.0.0.*; Capture = 0.0.1.*
  return /\{0\.0\.0\.00000000\}\./i.test(mmId);
}

function matchAudioDevice(
  devices: AudioDeviceRow[],
  deviceId: string,
  deviceName: string,
): AudioDeviceRow | null {
  const idNeedle = deviceId.trim().toLowerCase();
  const nameNeedle = deviceName.trim().toLowerCase();
  for (const d of devices) {
    const id = String(d.id ?? "").trim();
    const name = String(d.name ?? "").trim();
    if (idNeedle && id.toLowerCase() === idNeedle) return d;
    if (idNeedle && toMmDeviceId(id)?.toLowerCase() === idNeedle) return d;
    if (nameNeedle && name.toLowerCase() === nameNeedle) return d;
  }
  // Partial id: accept full GUID suffix after the last "." only (not loose includes).
  if (idNeedle) {
    for (const d of devices) {
      const id = String(d.id ?? "").trim();
      const mm = toMmDeviceId(id);
      const guid = (mm ?? id).split(".").pop()?.toLowerCase() ?? "";
      if (
        guid &&
        (guid === idNeedle ||
          `{${idNeedle}}` === guid ||
          idNeedle === guid.replace(/^\{|\}$/g, ""))
      ) {
        return d;
      }
    }
  }
  return null;
}

async function setDefaultAudioWin(
  deviceId: string,
  deviceName: string,
): Promise<HostOpResult> {
  const listed = await listAudioDevicesWin();
  if (!listed.ok) return listed;
  const devices = asDeviceRows(listed.value);
  const matched = matchAudioDevice(devices, deviceId, deviceName);
  if (!matched) {
    return err(
      "device not found in host_audio_devices observation; refuse unknown device",
      "HostAudioDeviceUnknown",
    );
  }
  const mmId = toMmDeviceId(String(matched.id ?? ""));
  if (!mmId) {
    return err(
      `cannot map device id to Core Audio endpoint: ${String(matched.id ?? "")}`,
      "HostAudioDeviceIdError",
    );
  }
  if (!isPlaybackEndpointId(mmId)) {
    return err(
      "host_audio_set_default only supports playback (render) endpoints",
      "HostAudioNotPlayback",
    );
  }

  // Undocumented IPolicyConfig — no extra deps; fail honestly if COM rejects.
  const script = `
$ErrorActionPreference = 'Stop'
$mmId = '${mmId.replace(/'/g, "''")}'
$friendly = '${String(matched.name ?? "").replace(/'/g, "''")}'
if (-not ('AgentCore.PolicyConfig' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AgentCore {
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  internal class PolicyConfigClient { }
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(string a, IntPtr b);
    [PreserveSig] int GetDeviceFormat(string a, int b, IntPtr c);
    [PreserveSig] int ResetDeviceFormat(string a);
    [PreserveSig] int SetDeviceFormat(string a, IntPtr b, IntPtr c);
    [PreserveSig] int GetProcessingPeriod(string a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetProcessingPeriod(string a, IntPtr b);
    [PreserveSig] int GetShareMode(string a, IntPtr b);
    [PreserveSig] int SetShareMode(string a, IntPtr b);
    [PreserveSig] int GetPropertyValue(string a, IntPtr b, IntPtr c);
    [PreserveSig] int SetPropertyValue(string a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint(
      [MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    [PreserveSig] int SetEndpointVisibility(string a, int b);
  }
  public static class PolicyConfig {
    public static int SetDefault(string deviceId) {
      var cfg = (IPolicyConfig)(object)new PolicyConfigClient();
      int hr = 0;
      for (int role = 0; role <= 2; role++) {
        int r = cfg.SetDefaultEndpoint(deviceId, role);
        if (r != 0) hr = r;
      }
      return hr;
    }
  }
}
'@
}
$hr = [AgentCore.PolicyConfig]::SetDefault($mmId)
if ($hr -ne 0) { throw "SetDefaultEndpoint failed HRESULT=$hr" }
[PSCustomObject]@{ set = $true; device_id = $mmId; name = $friendly } | ConvertTo-Json -Compress
`.trim();

  try {
    const raw = await runPowerShellEncoded(script, 20_000);
    if (!raw) {
      return ok({
        platform: "win32",
        set: true,
        device_id: mmId,
        name: matched.name ?? null,
      });
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ok({ platform: "win32", ...parsed });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostAudioSetDefaultError",
    );
  }
}

export async function setDefaultAudio(
  deviceId: string,
  deviceName: string,
): Promise<HostOpResult> {
  if (!deviceId.trim() && !deviceName.trim()) {
    return err("device_id or device_name is required");
  }
  if (process.platform === "win32") {
    return setDefaultAudioWin(deviceId, deviceName);
  }
  return err(
    `host_audio_set_default not implemented on ${process.platform}`,
    "HostAudioSetDefaultStub",
  );
}
