/**
 * 工作流出处的判据。
 *
 * 出处曾写在 definition 顶层，而 definition 是客户端整份覆盖的画布文档：用户存一次
 * 就把它抹了，这条工作流从此触发不了「跑一次」时的按需抽槽。现在只认工作流顶层那份
 * 服务端字段——这里钉死这条线，别再从 definition 里读回去。
 */
import { describe, expect, it } from "vitest";
import {
  isWorkflowFromTurn,
  parseWorkflowSource,
  workflowTurnPath,
} from "../workflowSource";
import { toUserWorkflow } from "../workflows";

const TURN_WIRE = {
  kind: "turn",
  conversation_id: "c-1",
  message_id: "m-1",
};

function wire(extra: Record<string, unknown>) {
  return {
    id: "wf-1",
    name: "竞品调研",
    description: null,
    definition: { nodes: [], edges: [] },
    version: 2,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
    ...extra,
  };
}

describe("parseWorkflowSource", () => {
  it("认得服务端给的固化出处（带原对话与消息定位）", () => {
    expect(parseWorkflowSource(TURN_WIRE)).toEqual({
      kind: "turn",
      conversationId: "c-1",
      messageId: "m-1",
    });
  });

  it("没有出处 / 形状不对时一律 null", () => {
    for (const raw of [
      null,
      undefined,
      "turn",
      [TURN_WIRE],
      {},
      { conversation_id: "c-1" },
      { kind: "  " },
    ]) {
      expect(parseWorkflowSource(raw)).toBeNull();
    }
  });

  it("只给了 kind 也成立：定位信息缺省为 null", () => {
    expect(parseWorkflowSource({ kind: "playbook" })).toEqual({
      kind: "playbook",
      conversationId: null,
      messageId: null,
    });
  });
});

describe("isWorkflowFromTurn", () => {
  it("只认 kind 为 turn 的那份", () => {
    expect(isWorkflowFromTurn(parseWorkflowSource(TURN_WIRE))).toBe(true);
    expect(isWorkflowFromTurn(parseWorkflowSource({ kind: "playbook" }))).toBe(
      false,
    );
    expect(isWorkflowFromTurn(null)).toBe(false);
    expect(isWorkflowFromTurn(undefined)).toBe(false);
  });
});

describe("wire → domain 的出处（列表 / 详情读取）", () => {
  it("读工作流顶层的 source", () => {
    const w = toUserWorkflow(wire({ source: TURN_WIRE }));
    expect(w.source).toEqual({
      kind: "turn",
      conversationId: "c-1",
      messageId: "m-1",
    });
    expect(isWorkflowFromTurn(w.source)).toBe(true);
  });

  it("definition 里的同名键不再是出处（用户在画布上塞不出一个固化来源）", () => {
    const w = toUserWorkflow(
      wire({
        definition: {
          nodes: [],
          edges: [],
          source: { kind: "turn", conversation_id: "c-9", message_id: "m-9" },
        },
      }),
    );
    expect(w.source).toBeNull();
    expect(isWorkflowFromTurn(w.source)).toBe(false);
  });

  it("服务端没给 source 时为 null（老记录 / 非固化来源）", () => {
    expect(toUserWorkflow(wire({})).source).toBeNull();
    expect(toUserWorkflow(wire({ source: null })).source).toBeNull();
  });
});

describe("workflowTurnPath", () => {
  it("给出落到那条消息上的对话链接", () => {
    expect(workflowTurnPath(parseWorkflowSource(TURN_WIRE))).toBe(
      "/conversations/c-1?msg=m-1",
    );
  });

  it("只知道对话时就跳对话；不知道对话就没得跳", () => {
    expect(workflowTurnPath(parseWorkflowSource({ kind: "turn" }))).toBeNull();
    expect(
      workflowTurnPath(
        parseWorkflowSource({ kind: "turn", conversation_id: "c-2" }),
      ),
    ).toBe("/conversations/c-2");
    expect(
      workflowTurnPath(parseWorkflowSource({ kind: "playbook" })),
    ).toBeNull();
  });
});
