import { FINISH_REASON_META } from "@/components/ui/finish-reason-chip";
import {
  connectivityEscalationSuffix,
  errorActionForCode,
  isConnectivityErrorCode,
  resetSessionConnectivityFailures,
  syntheticErrorForEmptyFailure,
} from "@/lib/errors";
import { afterEach, describe, expect, it } from "vitest";

describe("syntheticErrorForEmptyFailure", () => {
  it("synthesizes a card for empty error-finished turns", () => {
    expect(syntheticErrorForEmptyFailure("error")).toEqual({
      code: "LLM_ERROR",
      message: "模型调用失败，请重试。",
    });
  });

  it("returns null for non-error finishes", () => {
    expect(syntheticErrorForEmptyFailure("end_turn")).toBeNull();
    expect(syntheticErrorForEmptyFailure("degraded")).toBeNull();
    expect(syntheticErrorForEmptyFailure(undefined)).toBeNull();
  });
});

describe("FinishReasonChip error meta", () => {
  it("includes an error entry", () => {
    expect(FINISH_REASON_META.error).toMatchObject({ label: "调用失败" });
  });
});

describe("error action by type", () => {
  it("auth / balance → 去设置; connectivity → null (retry in bubble)", () => {
    expect(errorActionForCode("LLM_KEY_INVALID")?.label).toBe("去设置");
    expect(errorActionForCode("LLM_INSUFFICIENT_BALANCE")?.label).toBe(
      "去设置",
    );
    expect(errorActionForCode("LLM_TIMEOUT")).toBeNull();
    expect(isConnectivityErrorCode("LLM_TIMEOUT")).toBe(true);
    expect(isConnectivityErrorCode("LLM_KEY_INVALID")).toBe(false);
  });
});

describe("connectivityEscalationSuffix", () => {
  afterEach(() => {
    resetSessionConnectivityFailures();
  });

  it("stays quiet on the first failure, escalates from the second message", () => {
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m1")).toBeNull();
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m2")).toContain(
      "设置 · 模型配置",
    );
    // Same message id must not re-count.
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m2")).toContain(
      "设置 · 模型配置",
    );
  });

  it("ignores non-connectivity codes", () => {
    expect(connectivityEscalationSuffix("LLM_KEY_INVALID", "m1")).toBeNull();
    expect(connectivityEscalationSuffix(undefined, "m1")).toBeNull();
  });
});
