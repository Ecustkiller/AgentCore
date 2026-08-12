import { FINISH_REASON_META } from "@/components/ui/finish-reason-chip";
import {
  EMPTY_RESPONSE_CHIP_LABELS,
  OUR_SERVICE_UNAVAILABLE_MESSAGE,
  StreamError,
  connectivityEscalationSuffix,
  degradedFinishChipLabel,
  describeError,
  errorActionForCode,
  isClientSideLlmRejection,
  isConnectivityErrorCode,
  isEmptyResponseUserSurface,
  isOurServiceErrorCode,
  resetSessionConnectivityFailures,
  resolveAssistantFailureFace,
  syntheticErrorForEmptyFailure,
  syntheticErrorForHardFailure,
  visibleMessageText,
} from "@/lib/errors";
import { afterEach, describe, expect, it } from "vitest";

describe("visibleMessageText", () => {
  it("prefers non-empty content over error (partial deliverable)", () => {
    expect(
      visibleMessageText({
        content: "半成品答案",
        error: { message: "模型调用失败，请重试。" },
      }),
    ).toBe("半成品答案");
  });

  it("falls back to error.message when content is empty", () => {
    expect(
      visibleMessageText({
        content: "  ",
        error: {
          message: "上游限流，暂时无法继续本回合。请稍后再试。",
        },
      }),
    ).toBe("上游限流，暂时无法继续本回合。请稍后再试。");
  });

  it("falls back to runs.error.message when message.error is absent", () => {
    expect(
      visibleMessageText({
        content: "",
        runs: { error: { message: "本地引擎启动失败" } },
      }),
    ).toBe("本地引擎启动失败");
  });

  it("does not hide content that equals the error string", () => {
    const same = "模型调用失败，请重试。";
    expect(
      visibleMessageText({
        content: same,
        error: { message: same },
      }),
    ).toBe(same);
  });

  it("returns empty when neither content nor error is present", () => {
    expect(visibleMessageText({ content: "" })).toBe("");
    expect(visibleMessageText({})).toBe("");
  });
});

describe("syntheticErrorForEmptyFailure", () => {
  it("synthesizes a card for empty error-finished turns", () => {
    expect(syntheticErrorForEmptyFailure("error")).toEqual({
      code: "LLM_ERROR",
      message: "模型调用失败，请重试。",
    });
  });

  it("synthesizes a card for empty unproductive-finished turns", () => {
    expect(syntheticErrorForEmptyFailure("unproductive")).toEqual({
      code: "LLM_UNPRODUCTIVE",
      message: "工具连续无有效进展或参数无效，请重试。",
    });
  });

  it("keeps upstream rate-limit product copy when code is known", () => {
    expect(syntheticErrorForEmptyFailure("error", "LLM_RATE_LIMIT")).toEqual({
      code: "LLM_RATE_LIMIT",
      message: "上游限流，暂时无法继续本回合。请稍后再试。",
    });
  });

  it("synthesizes cancelled / interrupted empty faces (B5 空泡)", () => {
    expect(syntheticErrorForEmptyFailure("cancelled")).toEqual({
      code: "TURN_CANCELLED",
      message: "已停止",
    });
    expect(syntheticErrorForEmptyFailure("interrupted")).toEqual({
      code: "TURN_INTERRUPTED",
      message: "已中断。直接发送下一条即可重试。",
    });
  });

  it("auth code wins over cancelled finish (platform face align)", () => {
    expect(
      syntheticErrorForEmptyFailure("cancelled", "LLM_KEY_INVALID"),
    ).toEqual({
      code: "LLM_KEY_INVALID",
      message:
        "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key，或联系管理员。",
    });
  });

  it("flips default ON for degraded / paused empty finishes", () => {
    expect(syntheticErrorForEmptyFailure("degraded")).toEqual({
      code: "LLM_EMPTY_RESPONSE",
      message: "模型返回空内容，请重试。",
    });
    expect(syntheticErrorForEmptyFailure("paused")).toEqual({
      code: "TURN_INCOMPLETE",
      message: "本轮未能完成，请重试。",
    });
  });

  it("returns null for non-failure finishes", () => {
    expect(syntheticErrorForEmptyFailure("end_turn")).toBeNull();
    expect(syntheticErrorForEmptyFailure("max_rounds")).toBeNull();
    expect(syntheticErrorForEmptyFailure(undefined)).toBeNull();
  });
});

describe("resolveAssistantFailureFace", () => {
  it("surfaces any structured error source on empty content", () => {
    expect(
      resolveAssistantFailureFace({
        content: "",
        usageError: {
          code: "LLM_INSUFFICIENT_BALANCE",
          message: "上游账户余额不足，请充值或更换 Key。",
        },
        finishReason: "error",
      }),
    ).toEqual({
      code: "LLM_INSUFFICIENT_BALANCE",
      message: "上游账户余额不足，请充值或更换 Key。",
    });
  });

  it("exempts paused when dedicated pause/ask UI owns the turn", () => {
    expect(
      resolveAssistantFailureFace({
        content: "",
        finishReason: "paused",
        hasDedicatedPauseOrAskUi: true,
      }),
    ).toBeNull();
  });

  it("still faces paused empty without a dedicated card", () => {
    expect(
      resolveAssistantFailureFace({
        content: "",
        finishReason: "paused",
        hasDedicatedPauseOrAskUi: false,
      })?.message,
    ).toBe("本轮未能完成，请重试。");
  });
});

describe("LLM_RATE_LIMIT connectivity", () => {
  it("treats upstream rate limit as retriable connectivity", () => {
    expect(isConnectivityErrorCode("LLM_RATE_LIMIT")).toBe(true);
  });
});

describe("FinishReasonChip error meta", () => {
  it("keeps error label for footer; chip itself must not paint it", () => {
    expect(FINISH_REASON_META.error).toMatchObject({ label: "调用失败" });
  });

  it("degraded default is 空响应收尾 (no 降级完成)", () => {
    expect(FINISH_REASON_META.degraded.label).toBe("空响应收尾");
    expect(FINISH_REASON_META.degraded.label).not.toContain("降级完成");
  });
});

describe("syntheticErrorForHardFailure", () => {
  it("synthesizes when finishReason=error even if body exists", () => {
    expect(syntheticErrorForHardFailure("error")).toEqual({
      code: "LLM_ERROR",
      message: "模型调用失败，请重试。",
    });
  });

  it("prefers runs.error message when present", () => {
    expect(
      syntheticErrorForHardFailure("error", {
        code: "LLM_KEY_INVALID",
        message:
          "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key，或联系管理员。",
      }),
    ).toEqual({
      code: "LLM_KEY_INVALID",
      message:
        "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key，或联系管理员。",
    });
  });

  it("returns null for soft finishes", () => {
    expect(syntheticErrorForHardFailure("degraded")).toBeNull();
    expect(syntheticErrorForHardFailure("max_rounds")).toBeNull();
    expect(syntheticErrorForHardFailure(undefined)).toBeNull();
  });
});

describe("empty-response diagnosis labels", () => {
  it("maps upstream_non_api / legacy oauth_expired without Sub2API", () => {
    const expected = "上游返回了网页或登录页，请检查服务商地址与鉴权";
    expect(EMPTY_RESPONSE_CHIP_LABELS.upstream_non_api).toBe(expected);
    expect(EMPTY_RESPONSE_CHIP_LABELS.oauth_expired).toBe(expected);
    expect(EMPTY_RESPONSE_CHIP_LABELS.oauth_expired).not.toContain("Sub2API");
    expect(EMPTY_RESPONSE_CHIP_LABELS.length_empty).toContain("截断");
  });

  it("degradedFinishChipLabel prefers diagnosis map", () => {
    expect(degradedFinishChipLabel("upstream_non_api", undefined)).toBe(
      "上游返回了网页或登录页，请检查服务商地址与鉴权",
    );
    expect(degradedFinishChipLabel("oauth_expired", undefined)).toBe(
      "上游返回了网页或登录页，请检查服务商地址与鉴权",
    );
  });
});

describe("isEmptyResponseUserSurface", () => {
  it("detects code / diagnosis / message markers", () => {
    expect(isEmptyResponseUserSurface({ code: "LLM_EMPTY_RESPONSE" })).toBe(
      true,
    );
    expect(isEmptyResponseUserSurface({ emptyDiagnosis: "silent_empty" })).toBe(
      true,
    );
    expect(
      isEmptyResponseUserSurface({
        message: "模型多次空响应 · 模型返回空内容",
      }),
    ).toBe(true);
    expect(
      isEmptyResponseUserSurface({
        message: "模型空响应 · 输出长度截断 · 返回空内容",
      }),
    ).toBe(true);
    expect(
      isEmptyResponseUserSurface({
        code: "LLM_ERROR",
        message: "模型调用失败，请重试。",
      }),
    ).toBe(false);
  });
});

describe("error action by type", () => {
  it("auth / balance → 去设置; connectivity → null (retry in bubble)", () => {
    expect(errorActionForCode("LLM_KEY_INVALID")?.label).toBe("去设置");
    expect(
      errorActionForCode("LLM_KEY_INVALID", { credentialSource: "user" })
        ?.label,
    ).toBe("去设置");
    expect(
      errorActionForCode("LLM_KEY_INVALID", { credentialSource: "platform" })
        ?.label,
    ).toBe("接入自己的 Key");
    expect(
      errorActionForCode("LLM_KEY_INVALID", {
        message: "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key",
      })?.label,
    ).toBe("接入自己的 Key");
    expect(errorActionForCode("LLM_INSUFFICIENT_BALANCE")?.label).toBe(
      "去设置",
    );
    expect(errorActionForCode("LLM_TIMEOUT")).toBeNull();
    expect(errorActionForCode("INFERENCE_TOKEN_EXPIRED")).toBeNull();
    expect(errorActionForCode("ALWAYS_QUOTA_EXCEEDED")).toEqual({
      label: "去清理常驻",
      href: "/files",
    });
    expect(isConnectivityErrorCode("LLM_TIMEOUT")).toBe(true);
    expect(isConnectivityErrorCode("LLM_KEY_INVALID")).toBe(false);
  });

  it("inference JWT expiry → retry, never 去设置 (incl. legacy English copy)", () => {
    const coded = describeError(
      new StreamError("http", undefined, {
        code: "INFERENCE_TOKEN_EXPIRED",
        serverMessage: "本地与云端的推理凭证已失效或过期。请点击重试",
      }),
    );
    expect(coded?.action).toBeNull();
    expect(coded?.retriable).toBe(true);

    const legacy = describeError(
      new StreamError("http", undefined, {
        code: "LLM_KEY_INVALID",
        serverMessage: "user Invalid or expired inference token",
      }),
    );
    expect(legacy?.action).toBeNull();
    expect(legacy?.retriable).toBe(true);
    expect(legacy?.message).toContain("推理凭证");
  });

  it("CLIENT_TOO_OLD / 426 → force-update copy, non-retriable", () => {
    const coded = describeError(
      new StreamError("http", 426, {
        code: "CLIENT_TOO_OLD",
        serverMessage: "client too old",
      }),
    );
    expect(coded?.message).toBe("桌面端版本过旧，请更新后再试");
    expect(coded?.retriable).toBe(false);

    const byStatus = describeError(new StreamError("http", 426));
    expect(byStatus?.message).toBe("桌面端版本过旧，请更新后再试");
    expect(byStatus?.retriable).toBe(false);
  });
});

describe("isClientSideLlmRejection", () => {
  it("treats 4xx (except 429) as client rejection", () => {
    expect(isClientSideLlmRejection({ upstreamStatus: 400 })).toBe(true);
    expect(isClientSideLlmRejection({ upstreamStatus: 422 })).toBe(true);
    expect(isClientSideLlmRejection({ upstreamStatus: 429 })).toBe(false);
    expect(isClientSideLlmRejection({ upstreamStatus: 502 })).toBe(false);
  });

  it("matches invalid_request copy in message text", () => {
    expect(
      isClientSideLlmRejection({
        message:
          "platform 请求参数或消息格式不被当前模型支持，请检查 messages、tools、tool_choice",
      }),
    ).toBe(true);
    expect(
      isClientSideLlmRejection({
        message: '{"error":{"code":"invalid_request"}}',
      }),
    ).toBe(true);
    expect(isClientSideLlmRejection({ message: "连接超时" })).toBe(false);
  });
});

describe("connectivityEscalationSuffix", () => {
  afterEach(() => {
    resetSessionConnectivityFailures();
  });

  it("stays quiet on the first failure, escalates from the second message", () => {
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m1")).toBeNull();
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m2")).toContain(
      "设置 · 服务商",
    );
    // Same message id must not re-count.
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m2")).toContain(
      "设置 · 服务商",
    );
  });

  it("ignores non-connectivity codes", () => {
    expect(connectivityEscalationSuffix("LLM_KEY_INVALID", "m1")).toBeNull();
    expect(connectivityEscalationSuffix(undefined, "m1")).toBeNull();
  });

  it("never escalates LLM_EMPTY_RESPONSE or emptyDiagnosis", () => {
    expect(isConnectivityErrorCode("LLM_EMPTY_RESPONSE")).toBe(false);
    expect(connectivityEscalationSuffix("LLM_EMPTY_RESPONSE", "m1")).toBeNull();
    expect(connectivityEscalationSuffix("LLM_EMPTY_RESPONSE", "m2")).toBeNull();
    // Even if a connectivity code somehow coexists with emptyDiagnosis, skip.
    expect(
      connectivityEscalationSuffix("LLM_TIMEOUT", "m1", {
        emptyDiagnosis: "silent_empty",
      }),
    ).toBeNull();
    expect(
      connectivityEscalationSuffix("LLM_TIMEOUT", "m2", {
        emptyDiagnosis: "upstream_non_api",
      }),
    ).toBeNull();
  });

  it("does not escalate upstream 400 invalid_request into connectivity hint", () => {
    expect(
      connectivityEscalationSuffix("LLM_ERROR", "m1", {
        message: "platform 请求参数或消息格式不被当前模型支持",
        upstreamStatus: 400,
      }),
    ).toBeNull();
    expect(
      connectivityEscalationSuffix("LLM_ERROR", "m2", {
        message: "platform 请求参数或消息格式不被当前模型支持",
        upstreamStatus: 400,
      }),
    ).toBeNull();
  });
});

describe("our-cloud DATABASE_UNAVAILABLE face", () => {
  afterEach(() => {
    resetSessionConnectivityFailures();
  });

  it("is not connectivity and never escalates to Base URL / API Key", () => {
    expect(isOurServiceErrorCode("DATABASE_UNAVAILABLE")).toBe(true);
    expect(isConnectivityErrorCode("DATABASE_UNAVAILABLE")).toBe(false);
    expect(
      connectivityEscalationSuffix("DATABASE_UNAVAILABLE", "m1"),
    ).toBeNull();
    expect(
      connectivityEscalationSuffix("DATABASE_UNAVAILABLE", "m2"),
    ).toBeNull();
    // Must not pollute the session counter used by true connectivity codes.
    expect(connectivityEscalationSuffix("LLM_TIMEOUT", "m3")).toBeNull();
  });

  it("honest product face, no settings CTA, still retriable", () => {
    const face = resolveAssistantFailureFace({
      content: "",
      finishReason: "error",
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: OUR_SERVICE_UNAVAILABLE_MESSAGE,
      },
    });
    expect(face).toEqual({
      code: "DATABASE_UNAVAILABLE",
      message: OUR_SERVICE_UNAVAILABLE_MESSAGE,
    });
    expect(face?.message).not.toContain("上游模型服务");
    expect(face?.message).not.toContain("Base URL");
    expect(errorActionForCode("DATABASE_UNAVAILABLE")).toBeNull();

    const described = describeError(
      new StreamError("http", 503, {
        code: "DATABASE_UNAVAILABLE",
        serverMessage: OUR_SERVICE_UNAVAILABLE_MESSAGE,
      }),
    );
    expect(described?.message).toBe(OUR_SERVICE_UNAVAILABLE_MESSAGE);
    expect(described?.retriable).toBe(true);
    expect(described?.action).toBeNull();
  });

  it("true upstream LLM_ERROR still escalates connectivity from the 2nd failure", () => {
    expect(isConnectivityErrorCode("LLM_ERROR")).toBe(true);
    expect(connectivityEscalationSuffix("LLM_ERROR", "u1")).toBeNull();
    expect(connectivityEscalationSuffix("LLM_ERROR", "u2")).toContain(
      "设置 · 服务商",
    );
  });
});
