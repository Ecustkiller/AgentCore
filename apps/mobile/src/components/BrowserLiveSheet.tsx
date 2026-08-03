/**
 * Mobile Sandbox browser live + takeover sheet (Step4 · B).
 *
 * Half / full bottom sheet over chat: attaches `…/browser/live` while open, swaps
 * jpeg frames via objectURL (revoke previous each frame), and offers takeover with
 * touch→mouse mapping through {@link toFrameSpace} + {@link createInputBatcher}.
 * Keyboard: keydown/keyup + compositionend / beforeinput → kind:"text" (IME / soft
 * keyboard；密码框可输入，不回显). Unmount / close → live `stop()` + best-effort
 * takeover `end`. No desktop `showBrowser` / right-dock chrome; no takeover archive
 * card (E 后置).
 */

import {
  type BrowserLiveConnection,
  type BrowserLiveState,
  startBrowserLive,
} from "@/api/browserLive";
import { listBrowserSessions } from "@/api/browserSessions";
import {
  type InputBatcher,
  createInputBatcher,
  endBrowserTakeover,
  sendBrowserInput,
  startBrowserTakeover,
  takeoverStartErrorMessage,
  toFrameSpace,
} from "@/api/browserTakeover";
import { Modal } from "@/components/Modal";
import {
  Hand,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorOff,
  Radio,
  WifiOff,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** base64 (no data: prefix) → Blob for per-frame objectURL swap. */
function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

type TakeoverPhase = "idle" | "starting" | "active" | "ending";

interface Placeholder {
  spin?: boolean;
  tone: "muted" | "warning";
  title: string;
  hint?: string;
  Icon: typeof Loader2;
}

function placeholderFor(
  connection: BrowserLiveConnection,
  status: BrowserLiveState | null,
  resolvingSession: boolean,
): Placeholder {
  if (resolvingSession) {
    return { Icon: Loader2, spin: true, tone: "muted", title: "连接中…" };
  }
  if (status === "no_session") {
    return {
      Icon: MonitorOff,
      tone: "muted",
      title: "当前没有进行中的直播",
      hint: "AI 开始使用浏览器后，画面会实时出现在这里",
    };
  }
  if (status === "session_closed") {
    return {
      Icon: MonitorOff,
      tone: "muted",
      title: "直播已结束",
      hint: "浏览器会话已关闭",
    };
  }
  if (connection === "reconnecting") {
    return { Icon: WifiOff, tone: "warning", title: "连接已断开，正在重连…" };
  }
  if (status === "started") {
    return { Icon: Loader2, spin: true, tone: "muted", title: "等待画面…" };
  }
  return { Icon: Loader2, spin: true, tone: "muted", title: "连接中…" };
}

function LivePlaceholder({
  connection,
  status,
  resolvingSession,
}: {
  connection: BrowserLiveConnection;
  status: BrowserLiveState | null;
  resolvingSession: boolean;
}) {
  const { Icon, spin, tone, title, hint } = placeholderFor(
    connection,
    status,
    resolvingSession,
  );
  return (
    <div className={`bls-placeholder bls-placeholder-${tone}`}>
      <Icon size={26} className={spin ? "bls-spin" : undefined} aria-hidden />
      <p className="bls-placeholder-title">{title}</p>
      {hint ? <p className="bls-placeholder-hint">{hint}</p> : null}
    </div>
  );
}

export function BrowserLiveSheet({
  conversationId,
  sessionId,
  open,
  onClose,
}: {
  conversationId: string;
  /** Registry tab pin; omit → resolve via GET …/browser/sessions active/first. */
  sessionId?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // Mount only while open so live SSE attaches on open and tears down on close
  // (无人看零开销). Parent may keep the component in the tree with open=false.
  if (!open) return null;
  return (
    <BrowserLiveSheetBody
      conversationId={conversationId}
      sessionId={sessionId}
      onClose={onClose}
    />
  );
}

function BrowserLiveSheetBody({
  conversationId,
  sessionId: sessionIdProp,
  onClose,
}: {
  conversationId: string;
  sessionId?: string | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(
    sessionIdProp?.trim() ? sessionIdProp.trim() : null,
  );
  const [resolvingSession, setResolvingSession] = useState(
    !sessionIdProp?.trim(),
  );
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<BrowserLiveState | null>(null);
  const [connection, setConnection] =
    useState<BrowserLiveConnection>("connecting");
  const [takeover, setTakeover] = useState<TakeoverPhase>("idle");
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [returnHint, setReturnHint] = useState(false);

  const frameUrlRef = useRef<string | null>(null);
  const frameDimRef = useRef<{ width: number; height: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const batcherRef = useRef<InputBatcher | null>(null);
  const draggingRef = useRef(false);
  const takeoverActiveRef = useRef(false);
  const composingRef = useRef(false);

  // Resolve session when prop omitted (list → active / first).
  useEffect(() => {
    const pinned = sessionIdProp?.trim();
    if (pinned) {
      setResolvedSessionId(pinned);
      setResolvingSession(false);
      return;
    }
    let cancelled = false;
    setResolvingSession(true);
    void listBrowserSessions(conversationId)
      .then((list) => {
        if (cancelled) return;
        const sid =
          list.activeSessionId?.trim() ||
          list.sessions[0]?.sessionId?.trim() ||
          "";
        if (sid) {
          setResolvedSessionId(sid);
          setResolvingSession(false);
        } else {
          setResolvedSessionId(null);
          setResolvingSession(false);
          setStatus("no_session");
          setConnection("open");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedSessionId(null);
        setResolvingSession(false);
        setStatus("no_session");
        setConnection("open");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, sessionIdProp]);

  // Attach live SSE once we have a session id.
  useEffect(() => {
    if (!resolvedSessionId) return;
    const client = startBrowserLive(conversationId, resolvedSessionId, {
      onFrame: (frame) => {
        frameDimRef.current = { width: frame.width, height: frame.height };
        const next = URL.createObjectURL(
          base64ToBlob(frame.frame_b64, "image/jpeg"),
        );
        const prev = frameUrlRef.current;
        frameUrlRef.current = next;
        setFrameUrl(next);
        if (prev) URL.revokeObjectURL(prev);
      },
      onStatus: setStatus,
      onConnection: setConnection,
    });
    return () => {
      client.stop();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [conversationId, resolvedSessionId]);

  const endTakeoverCore = useCallback(() => {
    if (!takeoverActiveRef.current) return;
    const sid = resolvedSessionId;
    takeoverActiveRef.current = false;
    draggingRef.current = false;
    batcherRef.current?.stop();
    batcherRef.current = null;
    if (sid) {
      void endBrowserTakeover(conversationId, sid).catch(() => {});
    }
  }, [conversationId, resolvedSessionId]);

  const returnControl = useCallback(
    (opts?: { showReturnHint?: boolean }) => {
      if (!takeoverActiveRef.current) return;
      setTakeover("ending");
      endTakeoverCore();
      setTakeover("idle");
      setTakeoverError(null);
      if (opts?.showReturnHint) setReturnHint(true);
    },
    [endTakeoverCore],
  );

  const beginTakeover = useCallback(async () => {
    if (!resolvedSessionId) return;
    setTakeoverError(null);
    setReturnHint(false);
    setTakeover("starting");
    try {
      await startBrowserTakeover(conversationId, resolvedSessionId);
      takeoverActiveRef.current = true;
      const sid = resolvedSessionId;
      batcherRef.current = createInputBatcher((events) =>
        sendBrowserInput(conversationId, sid, events),
      );
      setTakeover("active");
    } catch (err) {
      setTakeover("idle");
      setTakeoverError(takeoverStartErrorMessage(err));
    }
  }, [conversationId, resolvedSessionId]);

  useEffect(() => {
    if (status === "session_closed" && takeoverActiveRef.current) {
      returnControl();
    }
  }, [status, returnControl]);

  useEffect(() => {
    if (takeover === "active") surfaceRef.current?.focus();
  }, [takeover]);

  // Soft-keyboard Latin / password: native beforeinput → kind:"text"
  // (React onBeforeInput is uneven across WebViews; keep composition* on the surface).
  useEffect(() => {
    if (takeover !== "active") return;
    const el = surfaceRef.current;
    if (!el) return;
    const onBeforeInputNative = (e: Event): void => {
      const ie = e as InputEvent;
      if (composingRef.current) return;
      if (ie.inputType && ie.inputType !== "insertText") return;
      if (!ie.data) return;
      e.preventDefault();
      batcherRef.current?.push({ kind: "text", text: ie.data });
    };
    el.addEventListener("beforeinput", onBeforeInputNative);
    return () => el.removeEventListener("beforeinput", onBeforeInputNative);
  }, [takeover]);

  // Best-effort end on unmount (close sheet / flip open→false).
  useEffect(() => {
    return () => endTakeoverCore();
  }, [endTakeoverCore]);

  const pushMouse = (
    type: "down" | "up" | "move" | "wheel",
    e: { clientX: number; clientY: number },
    extra?: {
      button?: number;
      delta_x?: number;
      delta_y?: number;
      click_count?: number;
    },
  ): void => {
    const batcher = batcherRef.current;
    const dim = frameDimRef.current;
    const el = surfaceRef.current;
    if (!batcher || !dim || !el) return;
    const rect = el.getBoundingClientRect();
    const { x, y } = toFrameSpace(
      e.clientX,
      e.clientY,
      rect,
      dim.width,
      dim.height,
    );
    batcher.push({ kind: "mouse", type, x, y, ...extra });
  };

  // Pointer Events cover touch → mouse on mobile WebView (no separate touch handlers).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    surfaceRef.current?.focus();
    draggingRef.current = true;
    try {
      surfaceRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported */
    }
    pushMouse("down", e, { button: e.button, click_count: 1 });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    pushMouse("move", e);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    draggingRef.current = false;
    try {
      surfaceRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
    pushMouse("up", e, { button: e.button });
  };

  const onPointerCancel = (): void => {
    draggingRef.current = false;
  };

  // Keyboard: inject only — never echo / persist keystrokes (密码不回显, D7).
  // Soft keyboard / IME: compositionend (or beforeinput insertText) → kind:"text".
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (composingRef.current) return; // IME 组合中 → 交给 compositionend 兜底
    e.preventDefault();
    batcherRef.current?.push({
      kind: "key",
      type: "down",
      key: e.key,
      code: e.code,
    });
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (composingRef.current) return;
    e.preventDefault();
    batcherRef.current?.push({
      kind: "key",
      type: "up",
      key: e.key,
      code: e.code,
    });
  };

  const onCompositionStart = (): void => {
    composingRef.current = true;
  };

  const onCompositionEnd = (
    e: React.CompositionEvent<HTMLDivElement>,
  ): void => {
    composingRef.current = false;
    // IME/组合输入兜底：只灌最终合成文本，不逐键上报（不缓存键入内容，守 D7）。
    if (e.data) batcherRef.current?.push({ kind: "text", text: e.data });
  };

  const showFrame = frameUrl !== null && status !== "no_session";
  const isLive =
    showFrame && status !== "session_closed" && connection === "open";
  const canTakeover =
    !!resolvedSessionId &&
    showFrame &&
    status === "started" &&
    connection === "open";
  const isTakingOver = takeover === "active" || takeover === "ending";

  return (
    <Modal
      className={`browser-live-sheet${expanded ? " is-full" : ""}`}
      onClose={onClose}
      label="浏览器直播"
    >
      <div className="bls-head">
        <div className="bls-head-title">
          {isTakingOver ? (
            <>
              <Hand size={14} aria-hidden />
              <span>接管中</span>
            </>
          ) : (
            <>
              <Radio
                size={14}
                className={isLive ? "bls-live-dot" : undefined}
                aria-hidden
              />
              <span>{isLive ? "直播中" : "浏览器直播"}</span>
            </>
          )}
        </div>
        <button
          type="button"
          className="bls-icon-btn"
          aria-label={expanded ? "半屏" : "全屏"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <Minimize2 size={16} aria-hidden />
          ) : (
            <Maximize2 size={16} aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="bls-icon-btn"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="bls-toolbar">
        {isTakingOver ? (
          <button
            type="button"
            className="bls-btn bls-btn-primary"
            onClick={() => returnControl({ showReturnHint: true })}
          >
            归还控制
          </button>
        ) : takeover === "starting" ? (
          <span className="bls-toolbar-status">
            <Loader2 size={14} className="bls-spin" aria-hidden />
            正在接管…
          </span>
        ) : canTakeover ? (
          <button
            type="button"
            className="bls-btn bls-btn-accent"
            onClick={() => void beginTakeover()}
          >
            <Hand size={14} aria-hidden />
            接管
          </button>
        ) : (
          <span className="bls-toolbar-hint">
            {isLive ? "观看中 · 点接管可操作远端" : "等待直播画面"}
          </span>
        )}
      </div>

      {takeoverError ? (
        <div className="bls-banner bls-banner-error" role="alert">
          <MonitorOff size={13} aria-hidden />
          {takeoverError}
        </div>
      ) : null}

      {returnHint && !takeoverError ? (
        <div className="bls-banner bls-banner-info">
          <Hand size={13} aria-hidden />
          控制已归还
        </div>
      ) : null}

      <div className="bls-body">
        {showFrame && frameUrl ? (
          isTakingOver ? (
            <div
              ref={surfaceRef}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: remote-control surface must be focusable for external keyboard inject; no semantic element for "proxy input to another screen".
              tabIndex={0}
              aria-label="接管中的浏览器画面（点按即操作远端）"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              className="bls-surface"
            >
              <img
                src={frameUrl}
                alt="浏览器直播画面"
                draggable={false}
                className="bls-frame bls-frame-interactive"
              />
            </div>
          ) : (
            <div className="bls-frame-wrap">
              <img
                src={frameUrl}
                alt="浏览器直播画面"
                className={`bls-frame${status === "session_closed" ? " is-ended" : ""}`}
              />
              {status === "session_closed" ? (
                <div className="bls-overlay">
                  <MonitorOff size={13} aria-hidden /> 直播已结束
                </div>
              ) : null}
              {status !== "session_closed" && connection === "reconnecting" ? (
                <div className="bls-overlay bls-overlay-warn">
                  <WifiOff size={13} aria-hidden /> 连接已断开，正在重连…
                </div>
              ) : null}
            </div>
          )
        ) : (
          <LivePlaceholder
            connection={connection}
            status={status}
            resolvingSession={resolvingSession}
          />
        )}
      </div>
    </Modal>
  );
}
