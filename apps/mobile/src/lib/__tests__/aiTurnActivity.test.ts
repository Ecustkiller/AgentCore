/**
 * `ai_turn_activity` 存储 —— snapshot replace、坏帧丢弃、running/done 进出、本机容器忽略。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAiTurnActivityForTests,
  applyAiTurnActivity,
  applyAiTurnActivitySnapshot,
  conversationCloudRunning,
  getAiTurnActivityRunning,
  ignoresCloudTurnActivity,
} from "../aiTurnActivity";

const A = "conv-a";
const B = "conv-b";

afterEach(() => {
  __resetAiTurnActivityForTests();
});

describe("ai_turn_activity_snapshot", () => {
  it("replace 整份 running 集合", () => {
    applyAiTurnActivitySnapshot({ running: [A] });
    applyAiTurnActivitySnapshot({ running: [B, A] });
    expect(getAiTurnActivityRunning()).toEqual([B, A]);

    applyAiTurnActivitySnapshot({ running: [] });
    expect(getAiTurnActivityRunning()).toEqual([]);
  });

  it("缺 running / 非数组的帧丢掉，不清现有集合", () => {
    applyAiTurnActivitySnapshot({ running: [A] });
    applyAiTurnActivitySnapshot(null);
    applyAiTurnActivitySnapshot({});
    applyAiTurnActivitySnapshot({ running: "nope" });
    expect(getAiTurnActivityRunning()).toEqual([A]);
  });
});

describe("ai_turn_activity", () => {
  it("running 进集合，done 出集合", () => {
    applyAiTurnActivity({ conversation_id: A, state: "running" });
    expect(getAiTurnActivityRunning()).toEqual([A]);

    applyAiTurnActivity({
      conversation_id: A,
      state: "done",
      reason: "completed",
    });
    expect(getAiTurnActivityRunning()).toEqual([]);
  });

  it("done 无 reason 仍移出 running", () => {
    applyAiTurnActivity({ conversation_id: A, state: "running" });
    applyAiTurnActivity({ conversation_id: A, state: "done" });
    expect(getAiTurnActivityRunning()).toEqual([]);
  });

  it("缺 conversation_id / 未知 state 丢掉", () => {
    applyAiTurnActivity({ conversation_id: A, state: "running" });
    applyAiTurnActivity({ state: "running" });
    applyAiTurnActivity({ conversation_id: B, state: "queued" });
    expect(getAiTurnActivityRunning()).toEqual([A]);
  });
});

describe("本机容器忽略", () => {
  it("local_container_root_id 有值则忽略云 running", () => {
    applyAiTurnActivity({ conversation_id: A, state: "running" });
    expect(conversationCloudRunning(A, null)).toBe(true);
    expect(conversationCloudRunning(A, "root-1")).toBe(false);
    expect(ignoresCloudTurnActivity("root-1")).toBe(true);
    expect(ignoresCloudTurnActivity(null)).toBe(false);
    expect(ignoresCloudTurnActivity(undefined)).toBe(false);
  });
});
