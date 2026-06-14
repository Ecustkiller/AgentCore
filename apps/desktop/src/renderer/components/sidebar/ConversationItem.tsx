import {
  deleteConversation,
  renameConversation,
} from "@/services/conversations";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  conversation: Conversation;
}

export function ConversationItem({ conversation }: Props) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const currentId = useConversationStore((s) => s.currentConversationId);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const removeConversation = useConversationStore((s) => s.removeConversation);
  const renameInStore = useConversationStore((s) => s.renameConversation);
  const navigate = useNavigate();
  const isActive = conversation.id === currentId;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(conversation.title);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const title = draft.trim();
    if (!title || title === conversation.title) return;
    renameInStore(conversation.id, title); // optimistic; reconcile on failure
    void renameConversation(conversation.id, title).catch(() => {
      renameInStore(conversation.id, conversation.title);
    });
  };

  const handleDelete = async () => {
    // Confirm server-side first so a failed delete leaves the item in place.
    try {
      await deleteConversation(conversation.id);
    } catch {
      return;
    }
    const wasActive = conversation.id === currentId;
    removeConversation(conversation.id);
    if (wasActive) navigate("/");
  };

  if (editing) {
    return (
      <div className="flex h-9 w-full items-center rounded-lg bg-sidebar-accent px-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              skipBlurRef.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            commitEdit();
          }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm text-sidebar-accent-foreground focus:outline-none"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`group flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      }`}
      onClick={() => {
        switchConversation(conversation.id);
        navigate(`/conversations/${conversation.id}`);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        startEdit();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="flex-1 truncate text-left">{conversation.title}</span>
      {hovered && (
        <span className="flex shrink-0 items-center gap-0.5">
          {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
          <span
            role="button"
            tabIndex={-1}
            aria-label="重命名对话"
            className="flex size-6 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                startEdit();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            <Pencil size={13} />
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
          <span
            role="button"
            tabIndex={-1}
            aria-label="删除对话"
            className="flex size-6 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-destructive"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                void handleDelete();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete();
            }}
          >
            <Trash2 size={13} />
          </span>
        </span>
      )}
    </button>
  );
}
