// @vitest-environment jsdom
import { useConversationStore } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphAppendAnchor } from "../GraphAppendAnchor";

const CID = "c-gappend-anchor";

describe("GraphAppendAnchor", () => {
  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: null, byId: {} });
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage({
      id: "client-m1",
      serverMessageId: "m1",
      role: "assistant",
      content: "host",
      createdAt: new Date().toISOString(),
      executionId: "exec1",
      isStreaming: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders 续自 copy and focuses the previous graph by hostMessageId", () => {
    render(<GraphAppendAnchor hostMessageId="m1" />);
    expect(screen.getByTestId("graph-append-anchor").textContent).toContain(
      "↑ 续自上一张协作图",
    );
    fireEvent.click(screen.getByTestId("graph-append-anchor"));
    expect(useConversationStore.getState().byId[CID].messageFocus?.id).toBe(
      "client-m1",
    );
  });

  it("navigates by prevExecutionId to the prior graph bubble", () => {
    render(<GraphAppendAnchor prevExecutionId="exec1" />);
    expect(screen.getByTestId("graph-append-anchor").textContent).toContain(
      "↑ 续自上一张协作图",
    );
    fireEvent.click(screen.getByTestId("graph-append-anchor"));
    expect(useConversationStore.getState().byId[CID].messageFocus?.id).toBe(
      "client-m1",
    );
  });

  it("uses debate-act copy when continuing a debate graph", () => {
    render(<GraphAppendAnchor prevExecutionId="exec1" actKind="debate" />);
    expect(screen.getByTestId("graph-append-anchor").textContent).toContain(
      "↑ 续自上一场辩论图",
    );
  });

  it("appends authorizedBy subtitle for stage_card / auto / preview", () => {
    render(
      <GraphAppendAnchor
        prevExecutionId="exec1"
        actKind="debate"
        authorizedBy="stage_card"
      />,
    );
    expect(screen.getByTestId("graph-append-anchor").textContent).toContain(
      "经推进卡授权",
    );
  });
});
