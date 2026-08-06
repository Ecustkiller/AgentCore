import type { HostOpResult } from "@shared/host-contract";

export function err(detail: string, kind = "HostOpError"): HostOpResult {
  return { ok: false, error: { kind, detail } };
}

export function ok(value: Record<string, unknown>): HostOpResult {
  return { ok: true, value };
}
