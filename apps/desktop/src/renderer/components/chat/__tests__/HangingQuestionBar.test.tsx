// @vitest-environment jsdom
import { ASK_INTENT_META } from "@/components/chat/decision";
import {
  HANGING_QUESTION_CAPTION,
  HANGING_QUESTION_CTA,
} from "@/lib/hangingQuestion";
import { notifyError } from "@/lib/toast";
import { sendAskReply } from "@/services/askReply";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { useInteractionStore } from "@/stores/interactions";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HangingQuestionBar } from "../HangingQuestionBar";
import { ResumePrompt } from "../ResumePrompt";

vi.mock("@/services/askReply", () => ({
  sendAskReply: vi.fn().mockResolvedValue("ok"),
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

const sendAskReplyMock = vi.mocked(sendAskReply);
const notifyErrorMock = vi.mocked(notifyError);

const CID = "conv-hanging";

function seedPendingAsk(id = "ask1") {
  useConversationStore.setState({
    currentConversationId: CID,
    byId: { [CID]: { ...EMPTY_RUNTIME, messages: [] } },
  });
  useInteractionStore.getState().upsertRequired({
    kind: "question_posted",
    conversationId: CID,
    messageId: "m1",
    payload: {
      ask_id: id,
      question: "需要同时导出 PDF 吗？",
      context: "默认仅 Markdown。",
      assumptions: [{ id: "a1", label: "格式", value: "仅 Markdown" }],
      questions: [],
    },
  });
}

beforeEach(() => {
  useInteractionStore.getState().clear();
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  sendAskReplyMock.mockReset();
  sendAskReplyMock.mockResolvedValue("ok");
  notifyErrorMock.mockReset();
});

afterEach(cleanup);

describe("HangingQuestionBar", () => {
  it("paints pending questions with the running-not-stuck face", () => {
    seedPendingAsk();
    render(<HangingQuestionBar />);
    expect(screen.getByTestId("hanging-question-bar")).toBeTruthy();
    expect(screen.getByTestId("hanging-question-caption").textContent).toBe(
      HANGING_QUESTION_CAPTION,
    );
    expect(screen.getByText("需要同时导出 PDF 吗？")).toBeTruthy();
    expect(screen.getByText("答复")).toBeTruthy();
    expect(document.body.textContent).toContain("没回之前按这个继续");
    expect(document.body.textContent).not.toContain(
      ASK_INTENT_META.decision.activeCaption,
    );
  });

  it("does not paint resolved questions", () => {
    seedPendingAsk();
    useInteractionStore.getState().markResolved({
      kind: "question_posted",
      id: "ask1",
      resolution: { status: "answered", answer: "也要", note: "" },
    });
    const { container } = render(<HangingQuestionBar />);
    expect(container.firstChild).toBeNull();
  });

  it("does not leak pending hanging questions into ResumePrompt", () => {
    seedPendingAsk();
    const { container } = render(<ResumePrompt />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("需要你拍板")).toBeNull();
  });

  it("queued reply clears draft without error toast and keeps the card", async () => {
    sendAskReplyMock.mockResolvedValueOnce("queued");
    seedPendingAsk();
    render(<HangingQuestionBar />);
    fireEvent.change(screen.getByTestId("hanging-question-input"), {
      target: { value: "也要 PDF。" },
    });
    fireEvent.click(screen.getByTestId("hanging-question-submit"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("hanging-question-input") as HTMLTextAreaElement)
          .value,
      ).toBe("");
    });
    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("hanging-question-card")).toBeTruthy();
    expect(sendAskReplyMock).toHaveBeenCalledWith({
      conversationId: CID,
      askId: "ask1",
      text: "也要 PDF。",
    });
    const input = screen.getByTestId(
      "hanging-question-input",
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByText(HANGING_QUESTION_CTA)).toBeTruthy();
    fireEvent.change(input, { target: { value: "第二句" } });
    expect(
      (screen.getByTestId("hanging-question-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("ok reply clears draft and unlocks while the card waits for server settlement", async () => {
    seedPendingAsk();
    render(<HangingQuestionBar />);
    fireEvent.change(screen.getByTestId("hanging-question-input"), {
      target: { value: "也要 PDF。" },
    });
    fireEvent.click(screen.getByTestId("hanging-question-submit"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("hanging-question-input") as HTMLTextAreaElement)
          .value,
      ).toBe("");
    });
    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("hanging-question-card")).toBeTruthy();
    expect(
      (screen.getByTestId("hanging-question-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
  });

  it("send_failed toasts and keeps the draft", async () => {
    sendAskReplyMock.mockResolvedValueOnce("send_failed");
    seedPendingAsk();
    render(<HangingQuestionBar />);
    fireEvent.change(screen.getByTestId("hanging-question-input"), {
      target: { value: "也要 PDF。" },
    });
    fireEvent.click(screen.getByTestId("hanging-question-submit"));
    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledWith("发送失败");
    });
    expect(
      (screen.getByTestId("hanging-question-input") as HTMLTextAreaElement)
        .value,
    ).toBe("也要 PDF。");
    expect(screen.getByTestId("hanging-question-card")).toBeTruthy();
  });
});
