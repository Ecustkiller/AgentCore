import { beforeEach, describe, expect, it } from "vitest";
import { useConversationStore } from "../conversation";

const store = () => useConversationStore.getState();

beforeEach(() => {
  useConversationStore.setState({
    conversations: [],
    currentConversationId: null,
    messages: [],
    isGenerating: false,
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
      expect(store().messages).toEqual([]);
      expect(store().isGenerating).toBe(false);
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
      expect(store().messages).toEqual([]);
      expect(store().isGenerating).toBe(false);
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
      expect(store().messages).toHaveLength(1);
      expect(store().messages[0].content).toBe("test");
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
      expect(store().messages[0].content).toBe("Hello world");
    });

    it("does nothing when no messages", () => {
      store().appendToLastMessage("chunk");
      expect(store().messages).toEqual([]);
    });
  });

  describe("createAssistantMessage", () => {
    it("creates an empty streaming assistant message", () => {
      const id = store().createAssistantMessage();

      expect(store().messages).toHaveLength(1);
      expect(store().messages[0].id).toBe(id);
      expect(store().messages[0].role).toBe("assistant");
      expect(store().messages[0].content).toBe("");
      expect(store().messages[0].isStreaming).toBe(true);
      expect(store().isGenerating).toBe(true);
    });
  });

  describe("finalizeLastMessage", () => {
    it("marks last message as non-streaming and clears isGenerating", () => {
      store().createAssistantMessage();
      store().appendToLastMessage("done");

      store().finalizeLastMessage();

      expect(store().messages[0].isStreaming).toBe(false);
      expect(store().isGenerating).toBe(false);
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
});
