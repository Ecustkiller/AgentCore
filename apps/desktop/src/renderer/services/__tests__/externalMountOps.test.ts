import type { ExternalMountReadonlyRequiredPayload } from "@/types/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveInteraction = vi.fn().mockResolvedValue(undefined);
const pickAndGrantReadonlyFolder = vi.fn();

vi.mock("@/services/interaction", () => ({
  resolveInteraction: (...args: unknown[]) => resolveInteraction(...args),
}));

vi.mock("@/lib/grantReadonlyFolder", () => ({
  pickAndGrantReadonlyFolder: (...args: unknown[]) =>
    pickAndGrantReadonlyFolder(...args),
}));

import { resetClientToolFulfillmentForTests } from "../clientToolFulfill";
import { performExternalMountReadonly } from "../externalMountOps";

function payload(
  over: Partial<ExternalMountReadonlyRequiredPayload> = {},
): ExternalMountReadonlyRequiredPayload {
  return {
    request_id: "req-1",
    conversation_id: "conv-1",
    well_known: "desktop",
    target_name: "咨询",
    ...over,
  };
}

describe("performExternalMountReadonly", () => {
  beforeEach(() => {
    resetClientToolFulfillmentForTests();
    resolveInteraction.mockClear();
    pickAndGrantReadonlyFolder.mockReset();
  });

  it("grants via IPC+POST and posts client_tool result (no abs)", async () => {
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: true,
      root: { id: "root-1", name: "咨询", alias: "咨询" },
      alias: "咨询",
      namespace: "external/咨询",
      displayLabel: "咨询",
    });

    await performExternalMountReadonly(payload(), "conv-1");

    expect(pickAndGrantReadonlyFolder).toHaveBeenCalledWith("conv-1", {
      wellKnown: "desktop",
      targetName: "咨询",
    });
    expect(resolveInteraction).toHaveBeenCalledWith(
      "conv-1",
      "req-1",
      expect.objectContaining({
        kind: "client_tool",
        ok: true,
        value: {
          root_id: "root-1",
          alias: "咨询",
          label: "咨询",
          display_label: "咨询",
          namespace: "external/咨询",
        },
      }),
    );
    const posted = resolveInteraction.mock.calls[0][2] as {
      value: Record<string, unknown>;
    };
    expect(posted.value).not.toHaveProperty("abs");
    expect(posted.value).not.toHaveProperty("absPath");
    expect(posted.value).not.toHaveProperty("path");
  });

  it("maps not_found to tool failure (clear detail)", async () => {
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: false,
      reason: "not_found",
      message: "找不到该目录",
    });

    await performExternalMountReadonly(
      payload({
        path: "C:/missing",
        well_known: undefined,
        target_name: undefined,
      }),
      "conv-1",
    );

    expect(pickAndGrantReadonlyFolder).toHaveBeenCalledWith("conv-1", {
      path: "C:/missing",
    });
    expect(resolveInteraction).toHaveBeenCalledWith(
      "conv-1",
      "req-1",
      expect.objectContaining({
        kind: "client_tool",
        ok: false,
        error: {
          kind: "ExternalMountError",
          detail: "找不到该目录",
        },
      }),
    );
  });

  it("fails cleanly when desktop channel unavailable", async () => {
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });

    await performExternalMountReadonly(payload(), "conv-1");

    expect(resolveInteraction).toHaveBeenCalledWith(
      "conv-1",
      "req-1",
      expect.objectContaining({
        ok: false,
        error: {
          kind: "ExternalMountError",
          detail: "非桌面环境，无法挂载本机目录",
        },
      }),
    );
  });

  it("does not re-grant on a second perform with the same request_id", async () => {
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: true,
      root: { id: "root-1", name: "咨询", alias: "咨询" },
      alias: "咨询",
      namespace: "external/咨询",
    });

    await performExternalMountReadonly(payload(), "conv-1");
    await performExternalMountReadonly(payload(), "conv-1");

    expect(pickAndGrantReadonlyFolder).toHaveBeenCalledTimes(1);
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
  });
});
