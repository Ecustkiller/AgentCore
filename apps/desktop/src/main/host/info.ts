import os from "node:os";
import type { HostOpResult } from "@shared/host-contract";
import { ok } from "./result";

export async function hostPing(): Promise<HostOpResult> {
  return ok({
    ok: true,
    platform: process.platform,
    ts: new Date().toISOString(),
  });
}

export async function hostInfo(): Promise<HostOpResult> {
  return ok({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    endianness: os.endianness(),
    cpus: os.cpus().length,
    total_mem_mb: Math.round(os.totalmem() / (1024 * 1024)),
    freemem_mb: Math.round(os.freemem() / (1024 * 1024)),
    uptime_s: Math.round(os.uptime()),
  });
}
