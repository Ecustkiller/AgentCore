import type { SSEEvent } from "@agentcore/contract-types";
import { describe, expect, it } from "vitest";
import {
  HANGING_QUESTION_CAPTION,
  HANGING_QUESTION_CTA,
  collectPendingHangingQuestions,
  eventsHaveExecutionDetached,
  formatHangingDefault,
} from "../hangingQuestion";

function ev(type: string, payload: Record<string, unknown>): SSEEvent {
  return { type, timestamp: "", payload } as SSEEvent;
}

describe("hangingQuestion copy", () => {
  it("does not reuse the paused-checkpoint caption or CTA", () => {
    expect(HANGING_QUESTION_CAPTION).toBe("有事等你，团队照跑");
    expect(HANGING_QUESTION_CTA).toBe("答复");
    expect(HANGING_QUESTION_CAPTION).not.toMatch(/拍板|挂起|停工|暂停/);
    expect(HANGING_QUESTION_CTA).not.toBe("提交");
  });

  it("formats a default-continues hint from assumptions", () => {
    expect(
      formatHangingDefault([{ id: "a1", label: "格式", value: "仅 Markdown" }]),
    ).toBe("没回之前按这个继续：格式：仅 Markdown");
    expect(formatHangingDefault([])).toBeNull();
  });
});

describe("collectPendingHangingQuestions", () => {
  it("keeps pending asks and drops resolved ones", () => {
    const posted = ev("question_posted", {
      ask_id: "ask1",
      question: "需要同时导出 PDF 吗？",
      context: "",
      assumptions: [],
      questions: [],
    });
    const resolved = ev("question_resolved", {
      ask_id: "ask1",
      status: "answered",
      answer: "也要",
    });
    expect(collectPendingHangingQuestions([[posted]])).toHaveLength(1);
    expect(collectPendingHangingQuestions([[posted, resolved]])).toHaveLength(
      0,
    );
  });

  it("does not cap the list", () => {
    const lists = [
      Array.from({ length: 4 }, (_, i) =>
        ev("question_posted", {
          ask_id: `ask${i}`,
          question: `题 ${i}`,
          context: "",
          assumptions: [],
          questions: [],
        }),
      ),
    ];
    expect(collectPendingHangingQuestions(lists)).toHaveLength(4);
  });

  it("settles when A posted and B only has question_resolved", () => {
    const posted = ev("question_posted", {
      ask_id: "ask1",
      question: "需要同时导出 PDF 吗？",
      context: "",
      assumptions: [],
      questions: [],
    });
    const resolved = ev("question_resolved", {
      ask_id: "ask1",
      status: "answered",
      answer: "也要",
    });
    expect(collectPendingHangingQuestions([[posted], [resolved]])).toEqual([]);
    // live-before-history (ChatPage hangingEventLists) is the reverse chronological order
    expect(collectPendingHangingQuestions([[resolved], [posted]])).toEqual([]);
  });
});

describe("eventsHaveExecutionDetached", () => {
  it("only inspects the current graph, not a historical detached stamp", () => {
    const posted = ev("question_posted", {
      ask_id: "ask1",
      question: "题",
      context: "",
      assumptions: [],
      questions: [],
    });
    const historicalDetached = ev("execution_detached", {
      completed: 1,
      total: 3,
    });
    expect(eventsHaveExecutionDetached([posted])).toBe(false);
    expect(eventsHaveExecutionDetached([posted, historicalDetached])).toBe(
      true,
    );
    // History window with detached must not be mixed into the current-graph argument.
    expect(
      collectPendingHangingQuestions([[posted], [historicalDetached]]),
    ).toHaveLength(1);
  });
});
