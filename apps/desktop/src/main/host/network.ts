import os from "node:os";
import type { HostOpResult } from "@shared/host-contract";
import { ok } from "./result";

export async function hostNetworkSummary(): Promise<HostOpResult> {
  // Local iface summary only — never port-scan or sniff.
  const ifaces = os.networkInterfaces();
  const adapters: Array<{
    name: string;
    addresses: Array<{ family: string; address: string }>;
  }> = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const addresses = addrs
      .filter((a) => !a.internal)
      .map((a) => ({
        family: String(a.family),
        address: a.address,
      }));
    if (addresses.length === 0) continue;
    adapters.push({ name, addresses });
  }
  return ok({
    platform: process.platform,
    hostname: os.hostname(),
    adapters,
    note: "local_iface_summary_no_port_scan",
  });
}
