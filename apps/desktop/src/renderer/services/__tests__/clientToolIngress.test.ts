import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchClientToolRequired = vi.fn();
const cancelClientToolByRequestId = vi.fn();
const logEvent = vi.fn();

vi.mock("@/lib/log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));
vi.mock("@/services/clientToolFrames", () => ({
  dispatchClientToolRequired: (...args: unknown[]) =>
    dispatchClientToolRequired(...args),
  cancelClientToolByRequestId: (...args: unknown[]) =>
    cancelClientToolByRequestId(...args),
  isClientToolRequiredType: (type: string) => type.endsWith("_required"),
}));
vi.mock("@/services/fulfillStream", () => ({
  onFulfillFrame: (cb: (frame: unknown) => void) => {
    cloudCb = cb;
    return () => {
      cloudCb = null;
    };
  },
}));

import {
  installClientToolIngress,
  resetClientToolIngressForTests,
} from "@/services/clientToolIngress";
import type { SidecarFulfillPush } from "@shared/sidecar-contract";

let cloudCb: ((frame: unknown) => void) | null = null;
let sidecarCb: ((push: SidecarFulfillPush) => void) | null = null;

/**
 * Both fulfill channels wired: the cloud device SSE (mocked module) and the
 * sidecar stdio push (`window.sidecarApi`).
 */
function install(): void {
  vi.stubGlobal("window", {
    sidecarApi: {
      onFulfillFrame: (cb: (push: SidecarFulfillPush) => void) => {
        sidecarCb = cb;
        return () => {
          sidecarCb = null;
        };
      },
    },
  });
  installClientToolIngress();
}

describe("clientToolIngress", () => {
  beforeEach(() => {
    resetClientToolIngressForTests();
    cloudCb = null;
    sidecarCb = null;
    dispatchClientToolRequired.mockReset();
    cancelClientToolByRequestId.mockReset();
    logEvent.mockReset();
    vi.unstubAllGlobals();
  });

  it("performs a sidecar frame with origin sidecar", () => {
    install();

    sidecarCb?.({
      conversationId: "c-1",
      frame: {
        type: "host_op_required",
        timestamp: "t0",
        payload: { request_id: "r-1", conversation_id: "c-1" },
      },
    });

    expect(dispatchClientToolRequired).toHaveBeenCalledWith(
      "host_op_required",
      { request_id: "r-1", conversation_id: "c-1" },
      "sidecar",
    );
  });

  it("performs a cloud frame with origin cloud", () => {
    install();

    cloudCb?.({
      type: "board_op_required",
      payload: { request_id: "r-2", conversation_id: "c-2" },
    });

    expect(dispatchClientToolRequired).toHaveBeenCalledWith(
      "board_op_required",
      { request_id: "r-2", conversation_id: "c-2" },
      "cloud",
    );
  });

  it("aborts on client_tool_cancelled from either channel", () => {
    install();

    // Sidecar shape: request_id inside payload.
    sidecarCb?.({
      conversationId: "c-1",
      frame: {
        type: "client_tool_cancelled",
        payload: { request_id: "r-side", conversation_id: "c-1" },
      },
    });
    // Cloud shape: request_id at the top level.
    cloudCb?.({ type: "client_tool_cancelled", request_id: "r-cloud" });

    expect(cancelClientToolByRequestId).toHaveBeenNthCalledWith(1, "r-side");
    expect(cancelClientToolByRequestId).toHaveBeenNthCalledWith(2, "r-cloud");
  });

  it("logs a cancel frame with no request_id instead of guessing", () => {
    install();

    sidecarCb?.({
      conversationId: "c-1",
      frame: { type: "client_tool_cancelled", payload: {} },
    });

    expect(cancelClientToolByRequestId).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "client_tool.cancel_missing_request_id",
      { origin: "sidecar" },
    );
  });

  it("ignores ready and non-CLIENT_TOOL frames", () => {
    install();

    sidecarCb?.({ conversationId: "c-1", frame: { type: "ready" } });
    sidecarCb?.({
      conversationId: "c-1",
      frame: { type: "some_other_event", payload: {} },
    });

    expect(dispatchClientToolRequired).not.toHaveBeenCalled();
    expect(cancelClientToolByRequestId).not.toHaveBeenCalled();
  });

  it("subscribes the sidecar channel at most once (double perform guard)", () => {
    const onFulfillFrameSpy = vi.fn(() => () => undefined);
    vi.stubGlobal("window", {
      sidecarApi: { onFulfillFrame: onFulfillFrameSpy },
    });

    installClientToolIngress();
    installClientToolIngress();

    expect(onFulfillFrameSpy).toHaveBeenCalledTimes(1);
  });

  it("installs without a sidecar bridge (web / cloud-only runtime)", () => {
    vi.stubGlobal("window", {});

    expect(() => installClientToolIngress()).not.toThrow();
    expect(cloudCb).not.toBeNull();
  });
});
