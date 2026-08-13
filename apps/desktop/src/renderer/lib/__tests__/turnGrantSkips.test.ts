import {
  countUnaskedSinceGrant,
  observedCallSpine,
  turnGrantScope,
} from "@/lib/turnGrantSkips";
import { describe, expect, it } from "vitest";

function call(toolCallId: string, toolName: string) {
  return { toolCallId, toolName };
}

describe("turnGrantScope", () => {
  it("approve_always 只覆盖卡上那个工具", () => {
    const scope = turnGrantScope("approve_always", "terminal");
    expect(scope?.has("terminal")).toBe(true);
    expect(scope?.has("file_write")).toBe(false);
  });

  it("approve_always_files 覆盖整个文件改动类（含 git 写入）", () => {
    const scope = turnGrantScope("approve_always_files", "file_write");
    expect(scope?.has("file_write")).toBe(true);
    expect(scope?.has("str_replace")).toBe(true);
    expect(scope?.has("git")).toBe(true);
    expect(scope?.has("code_execute")).toBe(false);
  });

  it("普通批准 / 拒绝不是轮内授权", () => {
    expect(turnGrantScope("approve", "terminal")).toBeNull();
    expect(turnGrantScope("deny", "terminal")).toBeNull();
  });
});

describe("countUnaskedSinceGrant", () => {
  const scope = new Set(["terminal"]);

  it("数出授权之后没再弹卡的同类调用", () => {
    const n = countUnaskedSinceGrant({
      calls: [
        call("t1", "terminal"),
        call("t2", "terminal"),
        call("t3", "terminal"),
        call("t4", "terminal"),
      ],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t1"]),
    });
    expect(n).toBe(3);
  });

  it("授权之前的调用不算——那些当时是逐个问过的", () => {
    const n = countUnaskedSinceGrant({
      calls: [
        call("t0", "terminal"),
        call("t1", "terminal"),
        call("t2", "terminal"),
      ],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t0", "t1"]),
    });
    expect(n).toBe(1);
  });

  it("弹过卡的（含被顺带放行的兄弟卡）不算跳过", () => {
    const n = countUnaskedSinceGrant({
      calls: [
        call("t1", "terminal"),
        call("t2", "terminal"),
        call("t3", "terminal"),
      ],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t1", "t2"]),
    });
    expect(n).toBe(1);
  });

  it("覆盖面外的工具不算", () => {
    const n = countUnaskedSinceGrant({
      calls: [call("t1", "terminal"), call("c1", "code_execute")],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t1"]),
    });
    expect(n).toBe(0);
  });

  it("重复到达的同一次调用只数一遍", () => {
    const n = countUnaskedSinceGrant({
      calls: [
        call("t1", "terminal"),
        call("t2", "terminal"),
        call("t2", "terminal"),
      ],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t1"]),
    });
    expect(n).toBe(1);
  });

  it("找不到授权那次调用就不猜：返回 0", () => {
    const n = countUnaskedSinceGrant({
      calls: [call("t2", "terminal"), call("t3", "terminal")],
      grantToolCallId: "t1",
      scope,
      askedToolCallIds: new Set(["t1"]),
    });
    expect(n).toBe(0);
  });
});

describe("observedCallSpine", () => {
  it("授权那次在 frame 流里 → frame 流是唯一权威（含队员调用）", () => {
    const spine = observedCallSpine({
      processCalls: [call("t1", "terminal")],
      frameCalls: [
        call("t1", "terminal"),
        call("w1", "terminal"),
        call("t2", "terminal"),
      ],
      grantToolCallId: "t1",
    });
    expect(spine.map((c) => c.toolCallId)).toEqual(["t1", "w1", "t2"]);
  });

  it("授权发生在派团之前 → 队员调用接在过程线尾部，且不重复计入", () => {
    const spine = observedCallSpine({
      processCalls: [call("t1", "terminal"), call("t2", "terminal")],
      frameCalls: [call("t2", "terminal"), call("w1", "terminal")],
      grantToolCallId: "t1",
    });
    expect(spine.map((c) => c.toolCallId)).toEqual(["t1", "t2", "w1"]);
  });

  it("单聊回合没有 frame 流：过程线即全部", () => {
    const spine = observedCallSpine({
      processCalls: [call("t1", "terminal"), call("t2", "terminal")],
      frameCalls: [],
      grantToolCallId: "t1",
    });
    expect(spine.map((c) => c.toolCallId)).toEqual(["t1", "t2"]);
  });
});
