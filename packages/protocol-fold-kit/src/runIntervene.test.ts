/**
 * 按人干预可用性判定 —— 两端共用这一份，说的必须是同一句。
 *
 * 调用方终局不画入口（`!isLiveRunStatus`）。本文件钉的是判定本身：live 可点；
 * 不可用分支（含排队未开工的改方向）永远给得出一句原因，供仍渲染的那一截使用。
 */
import { describe, expect, it } from "vitest";
import {
  interveneAckText,
  isLiveRunStatus,
  runRedirectGate,
  runStopGate,
} from "./runIntervene";

const SETTLED = ["completed", "failed", "cancelled", "skipped"] as const;

describe("runStopGate", () => {
  it("在飞 / 排队中可停", () => {
    expect(runStopGate("running").enabled).toBe(true);
    expect(runStopGate("pending").enabled).toBe(true);
    expect(runStopGate("running").reason).toBeNull();
  });

  it("终局态不可停，但一定说得出为什么", () => {
    for (const status of SETTLED) {
      const gate = runStopGate(status);
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toBeTruthy();
    }
  });

  it("未知状态也不留空原因（老 journal / 新增状态不许静默消失）", () => {
    const gate = runStopGate("something_new");
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBeTruthy();
  });
});

describe("runRedirectGate", () => {
  it("run 在跑就放行——够不够得着由服务端答，本端不猜", () => {
    const gate = runRedirectGate("running");
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toBeNull();
  });

  it("跑完的队员改不动，原因指向 CEO 可以安排重做", () => {
    const gate = runRedirectGate("completed");
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("CEO");
  });

  it("还没开工没有在跑的工作可改，但提示可以直接停", () => {
    const gate = runRedirectGate("pending");
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("停");
  });

  it("同一个 run 状态，三端问出来必须是同一个答案", () => {
    // 回归闸：曾经这里还收一个 turnLive（气泡还在流吗），团队转后台跑时它与「引擎够得着」
    // 分离，于是同一个在飞 run 一处「可以改方向」、另一处「这一轮已经结束了」。
    // 现在粗过滤只认 run 自己的状态，本端再没有第二个自变量可分叉。
    expect(runRedirectGate("running")).toEqual(runRedirectGate("running"));
    expect(runStopGate("running").enabled).toBe(
      runRedirectGate("running").enabled,
    );
  });

  it("任何不可用分支都带原因（仍渲染的那一截用；终局由调用方整条不画）", () => {
    for (const status of [...SETTLED, "pending", "running", "weird"]) {
      const gate = runRedirectGate(status);
      if (gate.enabled) {
        expect(gate.reason).toBeNull();
      } else {
        expect(gate.reason).toBeTruthy();
      }
    }
  });
});

describe("interveneAckText（服务端怎么答，就怎么说）", () => {
  it("有服务端原话就原样用——三端同一句", () => {
    expect(
      interveneAckText({
        accepted: false,
        reason: "no_live_drive",
        detail: "这批工作已经不在引擎手里了，没有能停的在跑队员。",
      }),
    ).toBe("这批工作已经不在引擎手里了，没有能停的在跑队员。");
  });

  it("缺原话时按受理与否兜一句，不许把没受理说成受理了", () => {
    expect(interveneAckText({ accepted: true })).toBeTruthy();
    const refused = interveneAckText({ accepted: false, detail: "  " });
    expect(refused).toBeTruthy();
    expect(refused).not.toBe(interveneAckText({ accepted: true }));
  });
});

describe("isLiveRunStatus", () => {
  it("只有 running / pending 算引擎还够得着", () => {
    expect(isLiveRunStatus("running")).toBe(true);
    expect(isLiveRunStatus("pending")).toBe(true);
    for (const status of SETTLED) {
      expect(isLiveRunStatus(status)).toBe(false);
    }
  });
});
