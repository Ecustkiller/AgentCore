import type { SSEEvent } from "@agentcore/contract-types";
import type { ProjectedTurn } from "@agentcore/protocol-conformance";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { logout } from "@/api/auth";
import { getTokens } from "@/api/client";
import { createConversation, streamMessage } from "@/api/stream";
import { fold } from "@/protocol/fold";

interface Turn {
  id: string;
  userText: string;
  events: SSEEvent[];
}

/** One-line status derived from the projected turn — proves the fold drives the UI
 * (进度 / 工具 / 审批 are all read off ProjectedTurn, not re-parsed from events). */
function summarize(p: ProjectedTurn): string | null {
  if (p.pendingInteraction) {
    const pi = p.pendingInteraction;
    if (pi.kind === "approval") return `⏸ 等待审批：${pi.toolName}`;
    if (pi.kind === "checkpoint") return `⏸ ${pi.question}`;
    return "⏸ 等待放行";
  }
  if (p.runs.length > 0) {
    const running = p.runs.filter((r) => r.status === "running").length;
    return `团队 ${p.progress.completed}/${p.progress.total} 完成${running ? ` · ${running} 进行中` : ""}`;
  }
  const tool = [...p.process].reverse().find((s) => s.kind === "tool");
  if (tool && tool.kind === "tool" && tool.status === "running")
    return `正在调用 ${tool.tool_name}…`;
  if (p.status === "failed") return "出错了";
  return null;
}

function AssistantBubble({ turn, live }: { turn: Turn; live: boolean }) {
  const p = useMemo(() => fold(turn.events), [turn.events]);
  const meta = summarize(p);
  const text = p.content || (p.reasoning ? "（思考中…）" : live ? "…" : "");
  return (
    <div className="bubble assistant">
      {text}
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

export function ChatPage() {
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    createConversation()
      .then(setConversationId)
      .catch((e) => {
        if (!getTokens()) {
          navigate("/login", { replace: true });
          return;
        }
        setError(e instanceof Error ? e.message : "创建会话失败");
      });
  }, [navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  async function send() {
    const text = input.trim();
    if (!text || !conversationId || sending) return;
    setInput("");
    setError(null);
    setSending(true);
    setTurns((t) => [...t, { id: crypto.randomUUID(), userText: text, events: [] }]);

    const appendEvent = (event: SSEEvent) =>
      setTurns((t) => {
        const next = t.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, events: [...last.events, event] };
        return next;
      });

    try {
      await streamMessage(conversationId, text, appendEvent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接中断");
    } finally {
      setSending(false);
    }
  }

  async function onLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="screen">
      <header className="bar">
        <span>AgentCore 手机端 · 骨架</span>
        <button type="button" className="link" onClick={onLogout}>
          退出
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {turns.length === 0 && (
          <p className="muted hint">发一条消息，看流式回复跑通。</p>
        )}
        {turns.map((turn, i) => (
          <div key={turn.id} className="turn">
            <div className="bubble user">{turn.userText}</div>
            <AssistantBubble turn={turn} live={sending && i === turns.length - 1} />
          </div>
        ))}
      </div>

      {error && <div className="error bar">{error}</div>}

      <div className="composer">
        <input
          placeholder={conversationId ? "说点什么…" : "正在创建会话…"}
          value={input}
          disabled={!conversationId || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!conversationId || sending || !input.trim()}
        >
          发送
        </button>
      </div>
    </div>
  );
}
