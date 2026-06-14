import { beforeEach, describe, expect, it } from "vitest";
import { getActiveRuntime, useConversationStore } from "../conversation";

const store = () => useConversationStore.getState();
/** Active conversation's runtime slice — runtime state is now keyed by id. */
const rt = () => getActiveRuntime();

beforeEach(() => {
  useConversationStore.setState({
    conversations: [],
    currentConversationId: null,
    byId: {},
  });
});

describe("conversation store", () => {
  describe("switchConversation", () => {
    it("clears messages and sets current id", () => {
      store().addMessage({
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      });
      store().setGenerating(true);

      store().switchConversation("conv-new");

      expect(store().currentConversationId).toBe("conv-new");
      expect(rt().messages).toEqual([]);
      expect(rt().isGenerating).toBe(false);
    });

    it("starts a fresh draft chat when switched to null", () => {
      store().switchConversation("conv-existing");
      store().addMessage({
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      });
      store().setGenerating(true);

      store().switchConversation(null);

      expect(store().currentConversationId).toBeNull();
      expect(rt().messages).toEqual([]);
      expect(rt().isGenerating).toBe(false);
    });
  });

  // Step 4: switching no longer aborts the turn you leave. A live turn keeps
  // streaming into its own slice in the background; an idle slice is released.
  describe("switchConversation (background turns)", () => {
    const userMsg = {
      id: "m1",
      role: "user" as const,
      content: "hi",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    };

    it("keeps a generating conversation's slice alive when leaving it", () => {
      store().switchConversation("a");
      store().createAssistantMessage(); // byId.a: streaming, isGenerating
      store().switchConversation("b");
      // a's live turn survives — not aborted, not released.
      expect(store().byId.a?.isGenerating).toBe(true);
      expect(store().byId.a?.messages).toHaveLength(1);
    });

    it("releases an idle conversation's buffer when leaving it", () => {
      store().switchConversation("a");
      store().addMessage(userMsg); // byId.a: idle (no live turn)
      store().switchConversation("b");
      // a is idle → buffer dropped so memory stays bounded (reloads on return).
      expect(store().byId.a).toBeUndefined();
    });

    it("returns to a live background turn without wiping its stream", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().appendToLastMessage("partial");
      store().switchConversation("b"); // a kept (busy)
      store().switchConversation("a"); // return to a
      expect(store().byId.a?.messages[0].content).toBe("partial");
      expect(store().byId.a?.isGenerating).toBe(true);
    });
  });

  describe("addMessage", () => {
    it("appends a message to the list", () => {
      const msg = {
        id: "m1",
        role: "user" as const,
        content: "test",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      };

      store().addMessage(msg);
      expect(rt().messages).toHaveLength(1);
      expect(rt().messages[0].content).toBe("test");
    });
  });

  describe("appendToLastMessage", () => {
    it("appends chunk to last message content", () => {
      store().addMessage({
        id: "m1",
        role: "assistant",
        content: "Hello",
        createdAt: "",
        executionId: null,
        isStreaming: true,
      });

      store().appendToLastMessage(" world");
      expect(rt().messages[0].content).toBe("Hello world");
    });

    it("does nothing when no messages", () => {
      store().appendToLastMessage("chunk");
      expect(rt().messages).toEqual([]);
    });
  });

  describe("createAssistantMessage", () => {
    it("creates an empty streaming assistant message", () => {
      const id = store().createAssistantMessage();

      expect(rt().messages).toHaveLength(1);
      expect(rt().messages[0].id).toBe(id);
      expect(rt().messages[0].role).toBe("assistant");
      expect(rt().messages[0].content).toBe("");
      expect(rt().messages[0].isStreaming).toBe(true);
      expect(rt().isGenerating).toBe(true);
    });
  });

  describe("finalizeLastMessage", () => {
    it("marks last message as non-streaming and clears isGenerating", () => {
      store().createAssistantMessage();
      store().appendToLastMessage("done");

      store().finalizeLastMessage();

      expect(rt().messages[0].isStreaming).toBe(false);
      expect(rt().isGenerating).toBe(false);
    });
  });

  describe("removeConversation", () => {
    it("removes conversation from list", () => {
      store().setConversations([
        {
          id: "a",
          title: "A",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
        },
        {
          id: "b",
          title: "B",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ]);

      store().removeConversation("a");
      expect(store().conversations).toHaveLength(1);
      expect(store().conversations[0].id).toBe("b");
    });

    it("clears currentConversationId if removed conversation is current", () => {
      store().setConversations([
        {
          id: "a",
          title: "A",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ]);
      store().switchConversation("a");

      store().removeConversation("a");
      expect(store().currentConversationId).toBeNull();
    });
  });

  describe("renameConversation", () => {
    it("updates conversation title", () => {
      store().setConversations([
        {
          id: "a",
          title: "原标题",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ]);

      store().renameConversation("a", "新标题");
      expect(store().conversations[0].title).toBe("新标题");
    });
  });

  describe("bumpConversation", () => {
    it("moves the conversation to the front and refreshes updatedAt", () => {
      store().setConversations([
        {
          id: "a",
          title: "A",
          updatedAt: "2020-01-01T00:00:00.000Z",
          messageCount: 0,
          lastMessagePreview: null,
        },
        {
          id: "b",
          title: "B",
          updatedAt: "2020-01-01T00:00:00.000Z",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ]);

      store().bumpConversation("b");

      const list = store().conversations;
      expect(list.map((c) => c.id)).toEqual(["b", "a"]);
      expect(Date.parse(list[0].updatedAt)).toBeGreaterThan(
        Date.parse("2020-01-01T00:00:00.000Z"),
      );
    });

    it("is a no-op when the id is not in the list", () => {
      store().setConversations([
        {
          id: "a",
          title: "A",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ]);

      store().bumpConversation("missing");
      expect(store().conversations.map((c) => c.id)).toEqual(["a"]);
    });
  });

  describe("restoreConversation", () => {
    it("undoes a bump, restoring original position and updatedAt", () => {
      const original = [
        {
          id: "a",
          title: "A",
          updatedAt: "2020-01-03T00:00:00.000Z",
          messageCount: 0,
          lastMessagePreview: null,
        },
        {
          id: "b",
          title: "B",
          updatedAt: "2020-01-02T00:00:00.000Z",
          messageCount: 0,
          lastMessagePreview: null,
        },
        {
          id: "c",
          title: "C",
          updatedAt: "2020-01-01T00:00:00.000Z",
          messageCount: 0,
          lastMessagePreview: null,
        },
      ];
      store().setConversations(original);

      // Bump "c" to the front (as a send would), then roll it back.
      store().bumpConversation("c");
      expect(store().conversations.map((x) => x.id)).toEqual(["c", "a", "b"]);

      store().restoreConversation("c", 2, "2020-01-01T00:00:00.000Z");

      expect(store().conversations.map((x) => x.id)).toEqual(["a", "b", "c"]);
      expect(store().conversations[2].updatedAt).toBe(
        "2020-01-01T00:00:00.000Z",
      );
    });
  });
});
