// 消息线程 (/im/c/:chatId) — one human↔human thread. REST + polling (no SSE): the open
// thread refetches the most-recent page every 4s and merges by id, so sends from the peer
// appear within a cycle. IM list pagination is created_at ASC (page 1 = oldest), so the
// thread lands on the LAST page and pages backward via「加载更早」.
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { me } from "@/api/auth";
import { getTokens } from "@/api/client";
import {
  type ChatMessageDetail,
  type ChatParticipant,
  type ChatSummary,
  type SendContentType,
  type StoredAttachment,
  blockUser,
  chatTitle,
  fetchChatAttachmentBlob,
  isImageAttachment,
  leaveChat,
  listChats,
  listMembers,
  listMessages,
  markRead,
  sendMessage,
  uploadChatFile,
} from "@/api/messaging";
import { shareOrDownloadFile } from "@/lib/share";
import { clock } from "@/lib/time";
import { usePolling } from "@/lib/usePolling";
import "@/pages/im/im.css";

const PAGE_SIZE = 100;

/** Dedupe by id + sort ascending by created_at — stable across overlapping polled pages. */
function mergeMessages(
  prev: ChatMessageDetail[],
  incoming: ChatMessageDetail[],
): ChatMessageDetail[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatThreadPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId } = useParams<{ chatId: string }>();
  const initialChat = (location.state as { chat?: ChatSummary } | null)?.chat ?? null;

  const [chat, setChat] = useState<ChatSummary | null>(initialChat);
  const [myId, setMyId] = useState<string | null>(null);
  const [members, setMembers] = useState<Map<string, ChatParticipant>>(new Map());
  const [messages, setMessages] = useState<ChatMessageDetail[]>([]);
  const [oldestPage, setOldestPage] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Files staged for the next send — uploaded to chat storage on send, then referenced as
  // StoredAttachments (unlike agent-chat, IM ships the file itself, images included).
  const [pending, setPending] = useState<File[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const totalRef = useRef(0);
  const initedRef = useRef(false);
  const lastMarkedRef = useRef<string | null>(null);

  // My identity (mine vs theirs alignment).
  useEffect(() => {
    me()
      .then((u) => setMyId(u.id))
      .catch(() => {
        if (!getTokens()) navigate("/login", { replace: true });
      });
  }, [navigate]);

  // Chat summary fallback when opened via a deep link (no router state).
  useEffect(() => {
    if (chat || !chatId) return;
    listChats()
      .then((cs) => {
        const found = cs.find((c) => c.id === chatId);
        if (found) setChat(found);
      })
      .catch(() => {});
  }, [chat, chatId]);

  // Group/official sender names (dm needs none — the only peer is the title).
  useEffect(() => {
    if (!chatId || !chat || chat.type === "dm") return;
    listMembers(chatId)
      .then((ms) => setMembers(new Map(ms.map((m) => [m.id, m]))))
      .catch(() => {});
  }, [chatId, chat]);

  usePolling(async () => {
    if (!chatId) return;
    try {
      if (!initedRef.current) {
        // Land on the most recent page: page 1 yields the total, then fetch the last page.
        const first = await listMessages(chatId, 1, PAGE_SIZE);
        totalRef.current = first.total;
        const lastPage = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
        if (lastPage === 1) {
          setMessages(first.messages);
          setOldestPage(1);
        } else {
          const last = await listMessages(chatId, lastPage, PAGE_SIZE);
          totalRef.current = last.total;
          setMessages(last.messages);
          setOldestPage(lastPage);
        }
        initedRef.current = true;
        setLoaded(true);
      } else {
        const lastPage = Math.max(1, Math.ceil((totalRef.current || 1) / PAGE_SIZE));
        const res = await listMessages(chatId, lastPage, PAGE_SIZE);
        totalRef.current = res.total;
        setMessages((prev) => mergeMessages(prev, res.messages));
      }
      setError(null);
    } catch (e) {
      if (!getTokens()) {
        navigate("/login", { replace: true });
        return;
      }
      if (!initedRef.current) {
        setError(e instanceof Error ? e.message : "加载消息失败");
        setLoaded(true);
      }
    }
  }, 4000);

  // Advance the read cursor when the newest message changes (drives unread counts).
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (chatId && last && lastMarkedRef.current !== last.id) {
      lastMarkedRef.current = last.id;
      void markRead(chatId, last.id).catch(() => {});
    }
  }, [messages, chatId]);

  // Keep pinned to the bottom for new messages — but only if the user is already there
  // (don't yank them up from reading history).
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function loadOlder() {
    const target = oldestPage - 1;
    if (target < 1 || !chatId) return;
    try {
      const res = await listMessages(chatId, target, PAGE_SIZE);
      setMessages((prev) => mergeMessages(prev, res.messages));
      setOldestPage(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载更早失败");
    }
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) setPending((prev) => [...prev, ...files]);
  }

  function removePending(idx: number) {
    setPending((prev) => prev.filter((_, i) => i !== idx));
  }

  // Send text and/or attachments. Files upload to chat storage FIRST (durable paths) — a
  // failed upload aborts the send and keeps the draft + files for retry. content_type is
  // derived (all-images → image, any non-image → file) to drive the peer's render.
  async function send() {
    const body = text.trim();
    const files = pending;
    if ((!body && files.length === 0) || !chatId || sending) return;
    setSending(true);
    setError(null);
    try {
      let attachments: StoredAttachment[] = [];
      if (files.length > 0) {
        attachments = await Promise.all(
          files.map(async (file) => {
            const path = `attachments/${crypto.randomUUID()}/${file.name}`;
            const res = await uploadChatFile(chatId, path, file);
            return {
              name: file.name,
              path: file.name,
              kind: "file",
              truncated: false,
              workspace_path: res.path,
              size_bytes: res.size_bytes,
              thumb_path: res.thumb_path,
            } satisfies StoredAttachment;
          }),
        );
      }
      const contentType: SendContentType =
        attachments.length === 0
          ? "text"
          : attachments.every((a) => isImageAttachment(a.name))
            ? "image"
            : "file";
      const msg = await sendMessage(chatId, {
        content: body || undefined,
        contentType,
        attachments,
        clientMsgId: crypto.randomUUID(),
      });
      setText("");
      setPending([]);
      totalRef.current += 1;
      atBottomRef.current = true;
      setMessages((prev) => mergeMessages(prev, [msg]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  async function onBlock() {
    setSheetOpen(false);
    if (!chat?.peer) return;
    try {
      await blockUser(chat.peer.id);
      navigate("/im", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "拉黑失败");
    }
  }

  async function onLeave() {
    setSheetOpen(false);
    if (!chatId) return;
    try {
      await leaveChat(chatId);
      navigate("/im", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "退出会话失败");
    }
  }

  const title = chat ? chatTitle(chat) : "对话";
  const isDm = chat?.type === "dm";

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="link" onClick={() => navigate("/im")}>
          ← 消息
        </button>
        <span className="viewer-name">{title}</span>
        <button type="button" className="link" onClick={() => setSheetOpen(true)}>
          ⋯
        </button>
      </header>

      <div className="messages" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}>
        {!loaded && <p className="muted hint">加载中…</p>}
        {loaded && oldestPage > 1 && (
          <button type="button" className="load-older" onClick={() => void loadOlder()}>
            加载更早
          </button>
        )}
        {loaded && messages.length === 0 && !error && (
          <p className="muted hint">还没有消息，发送第一条吧。</p>
        )}
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            mine={!!myId && m.sender_user_id === myId}
            chatId={chatId ?? ""}
            isGroup={!isDm}
            senderName={
              m.sender_user_id ? members.get(m.sender_user_id)?.display_name : undefined
            }
          />
        ))}
      </div>

      {chat?.state === "pending" && (
        <div className="im-pending-note">陌生人的消息请求：回复即表示接受。</div>
      )}

      {error && <div className="error bar">{error}</div>}

      {pending.length > 0 && (
        <div className="attach-tray">
          {pending.map((f, i) => (
            <span key={`${f.name}-${i}`} className="attach-chip">
              <span aria-hidden>📎</span>
              <span className="attach-chip-name">{f.name}</span>
              <span className="attach-chip-trunc">{formatSize(f.size)}</span>
              <button
                type="button"
                className="attach-chip-x"
                onClick={() => removePending(i)}
                aria-label="移除附件"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer">
        <input
          ref={attachInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={onPickFiles}
        />
        <button
          type="button"
          className="attach-btn"
          onClick={() => attachInputRef.current?.click()}
          disabled={sending}
          aria-label="添加附件"
        >
          ＋
        </button>
        <input
          value={text}
          placeholder="发送消息…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={(!text.trim() && pending.length === 0) || sending}
        >
          {sending ? "…" : "发送"}
        </button>
      </div>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{title}</div>
            {isDm ? (
              <button type="button" className="sheet-item sheet-danger" onClick={() => void onBlock()}>
                拉黑此人
              </button>
            ) : (
              <button type="button" className="sheet-item sheet-danger" onClick={() => void onLeave()}>
                退出会话
              </button>
            )}
            <button type="button" className="sheet-item sheet-cancel" onClick={() => setSheetOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  mine,
  chatId,
  isGroup,
  senderName,
}: {
  message: ChatMessageDetail;
  mine: boolean;
  chatId: string;
  isGroup: boolean;
  senderName?: string;
}) {
  // Server-minted official notices / system cards render centered, not as a bubble.
  if (message.content_type === "system_card" || message.sender_type === "official") {
    return <div className="im-system">{message.content || "（系统消息）"}</div>;
  }

  const attachments = message.attachments ?? [];
  return (
    <div className={`im-msg ${mine ? "mine" : "theirs"}`}>
      {!mine && isGroup && senderName && <span className="im-sender">{senderName}</span>}
      <div className="im-bubble">
        {message.content}
        {attachments.length > 0 && (
          <div className="im-attachments">
            {attachments.map((a, i) => (
              <Attachment key={a.workspace_path ?? `${a.name}-${i}`} chatId={chatId} attachment={a} />
            ))}
          </div>
        )}
      </div>
      <span className="im-msg-time">{clock(message.created_at)}</span>
    </div>
  );
}

/** One attachment: an inline image (fetched as a blob — bearer can't ride an <img src>),
 *  else a file chip that shares/saves on tap. */
function Attachment({
  chatId,
  attachment,
}: {
  chatId: string;
  attachment: StoredAttachment;
}) {
  const path = attachment.workspace_path ?? null;
  const image = isImageAttachment(attachment.name);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!image || !path) return;
    let url: string | null = null;
    let cancelled = false;
    fetchChatAttachmentBlob(chatId, path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImgUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [chatId, path, image]);

  async function open() {
    if (!path || busy) return;
    setBusy(true);
    try {
      const blob = await fetchChatAttachmentBlob(chatId, path);
      await shareOrDownloadFile(blob, attachment.name, blob.type);
    } catch {
      /* best-effort */
    } finally {
      setBusy(false);
    }
  }

  if (image && path) {
    return imgUrl ? (
      <img className="im-attach-img" src={imgUrl} alt={attachment.name} onClick={() => void open()} />
    ) : (
      <div className="im-attach-file">
        <span className="im-attach-name">{attachment.name}</span>
      </div>
    );
  }

  return (
    <button type="button" className="im-attach-file" onClick={() => void open()} disabled={!path || busy}>
      <span aria-hidden>📎</span>
      <span className="im-attach-name">{attachment.name}</span>
      {attachment.size_bytes != null && (
        <span className="im-attach-size">{formatSize(attachment.size_bytes)}</span>
      )}
    </button>
  );
}
