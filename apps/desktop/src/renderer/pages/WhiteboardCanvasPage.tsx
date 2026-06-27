import {
  Excalidraw,
  convertToExcalidrawElements,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Button, IconButton } from "@/components/ui";
import { resolveDark } from "@/lib/theme";
import { notifyError, notifyInfo } from "@/lib/toast";
import {
  type BoardApplyResult,
  type BoardElement,
  applyExistingEdits,
  applyGroups,
  buildNodeSkeletons,
  mergeAppliedScene,
  registerBoardApplier,
} from "@/services/boardOps";
import {
  describeSelection,
  organizeSelectionPrompt,
  sendBoardTurn,
} from "@/services/boardTurn";
import {
  type BoardDetail,
  getBoard,
  renameBoard,
  saveBoardScene,
} from "@/services/boards";
import { useUIStore } from "@/stores/ui";
import type { BoardOp } from "@/types/events";
import { ArrowLeft, ArrowUp, Loader2, Sparkles, Square } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type SceneChange = NonNullable<ExcalidrawProps["onChange"]>;
type ChangeArgs = Parameters<SceneChange>;
type ExcalidrawAPI = Parameters<
  NonNullable<ExcalidrawProps["excalidrawAPI"]>
>[0];
type SceneElements = Parameters<ExcalidrawAPI["updateScene"]>[0]["elements"];

type SaveStatus = "idle" | "saving" | "saved" | "error";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

/** One board's canvas (AI协作白板.md §六 集成层 / §九 M1). Loads the scene from the
 * backend, autosaves it back (debounced) with a CAS ``baseline`` so a stale tab/device
 * never clobbers — on conflict autosave pauses and offers a reload (§七 不覆盖). */
export function WhiteboardCanvasPage() {
  const { boardId = "" } = useParams();
  const navigate = useNavigate();
  const theme = useUIStore((s) => s.theme);

  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState("");

  // 老板命令栏 (AI协作白板.md §六 M2 入口): the draft order + whether an AI turn on this
  // board is in flight (turns don't stack — the bar is disabled meanwhile, with a stop).
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);

  // Imperative Excalidraw handle (set via the excalidrawAPI callback): the AI applier
  // reads the live scene + pushes ops through it.
  const excalidrawApiRef = useRef<ExcalidrawAPI | null>(null);
  // CAS version of the last load/save; sent as the next write's baseline.
  const versionRef = useRef(0);
  // Latest onChange args (Excalidraw fires often) — the debounced flush reads this.
  const latestRef = useRef<ChangeArgs | null>(null);
  // Serialized scene of the last persisted/loaded state — skip no-op saves so merely
  // opening a board (Excalidraw's own init onChange) doesn't bump the version.
  const savedSceneRef = useRef("");
  // Once a conflict is seen, stop scheduling writes until the user reloads.
  const conflictRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBoard = useCallback(() => {
    setBoard(null);
    setLoadError(false);
    setStatus("idle");
    setConflict(false);
    conflictRef.current = false;
    latestRef.current = null;
    getBoard(boardId)
      .then((b) => {
        versionRef.current = b.version;
        setTitle(b.title);
        setBoard(b);
      })
      .catch(() => setLoadError(true));
  }, [boardId]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Leaving the board: stop pumping this turn's stream (it detaches server-side; the
      // applier is unregistered on unmount, so further ops would have nowhere to land).
      aiAbortRef.current?.abort();
    };
  }, []);

  const initialData = useMemo<ExcalidrawProps["initialData"]>(() => {
    if (!board) return null;
    const restored = restore(
      board.scene as Parameters<typeof restore>[0],
      null,
      null,
    );
    restored.appState.gridModeEnabled = true;
    savedSceneRef.current = serializeAsJSON(
      restored.elements,
      restored.appState,
      restored.files ?? {},
      "database",
    );
    return restored;
  }, [board]);

  // CAS-write a serialized scene. Shared by the debounced autosave (user edits) and the
  // AI applier (which needs the resulting version for its回执). Returns the new version,
  // or null on conflict/error. A no-op (scene unchanged) returns the current version so
  // the AI applier's explicit save right after an updateScene doesn't double-write.
  const persist = useCallback(
    async (sceneStr: string): Promise<number | null> => {
      if (sceneStr === savedSceneRef.current) return versionRef.current;
      setStatus("saving");
      try {
        const res = await saveBoardScene(
          boardId,
          JSON.parse(sceneStr),
          versionRef.current,
        );
        if (res.conflict) {
          conflictRef.current = true;
          setConflict(true);
          setStatus("idle");
          return null;
        }
        versionRef.current = res.version;
        savedSceneRef.current = sceneStr;
        setStatus("saved");
        return res.version;
      } catch {
        setStatus("error");
        return null;
      }
    },
    [boardId],
  );

  const flush = useCallback(async () => {
    const snap = latestRef.current;
    if (!snap || conflictRef.current) return;
    await persist(serializeAsJSON(snap[0], snap[1], snap[2], "database"));
  }, [persist]);

  const handleChange = useCallback<SceneChange>(
    (...args) => {
      latestRef.current = args;
      if (conflictRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), 1500);
    },
    [flush],
  );

  // The AI's hands on this canvas (AI协作白板.md §六 M2): convert the op batch to
  // Excalidraw elements, apply existing-element edits + grouping, push to the scene, and
  // CAS-save so the回执 carries the real version. Registered (keyed by board id) only
  // while THIS canvas is open, so board_op_required for a board no one is viewing fails
  // cleanly (the handler reports「画布未打开」).
  const applyOps = useCallback(
    async (ops: BoardOp[]): Promise<BoardApplyResult> => {
      const api = excalidrawApiRef.current;
      if (!api) throw new Error("画布尚未就绪");
      if (conflictRef.current) {
        throw new Error("白板存在版本冲突，已暂停修改，请先重新加载");
      }
      const current = api.getSceneElements() as unknown as BoardElement[];
      const edited = applyExistingEdits(current, ops);
      // `connect` may target existing nodes, so the converter needs their geometry to bind
      // the arrow (passthrough skeletons); build the lookup from the POST-edit set so a
      // same-batch move/delete is respected.
      const editedById = new Map(edited.map((el) => [el.id, el]));
      const { skeletons, createdIds, refToId } = buildNodeSkeletons(
        ops,
        editedById,
      );
      // regenerateIds:false keeps our node ids + the passthrough endpoints' real ids, so
      // arrows bind to the live elements and the merge can tell new from existing.
      const converted = skeletons.length
        ? (convertToExcalidrawElements(
            skeletons as Parameters<typeof convertToExcalidrawElements>[0],
            { regenerateIds: false },
          ) as unknown as BoardElement[])
        : [];
      const finalEls = mergeAppliedScene(edited, converted);
      applyGroups(finalEls, ops, refToId);
      api.updateScene({ elements: finalEls as unknown as SceneElements });
      const sceneStr = serializeAsJSON(
        finalEls as unknown as Parameters<typeof serializeAsJSON>[0],
        api.getAppState(),
        api.getFiles(),
        "database",
      );
      const version = await persist(sceneStr);
      if (version === null) throw new Error("白板保存失败（可能版本冲突）");
      return { applied: ops.length, created: createdIds, version };
    },
    [persist],
  );

  useEffect(() => {
    if (!boardId) return;
    return registerBoardApplier(boardId, applyOps);
  }, [boardId, applyOps]);

  // Run one AI turn on this board's conversation (老板命令栏 / 整理选区). board_op_required
  // events stream back to the applier above and draw; a user stop aborts the stream (the
  // server turn detaches). Turns don't stack — `aiBusy` gates re-entry.
  const runBoardTurn = useCallback(
    async (prompt: string) => {
      if (!boardId || aiBusy) return;
      setAiBusy(true);
      const ac = new AbortController();
      aiAbortRef.current = ac;
      try {
        await sendBoardTurn(boardId, prompt, ac.signal);
      } catch (err) {
        if (!ac.signal.aborted) notifyError(err, "AI 作画失败");
      } finally {
        if (aiAbortRef.current === ac) aiAbortRef.current = null;
        setAiBusy(false);
      }
    },
    [boardId, aiBusy],
  );

  const submitOrder = useCallback(() => {
    const text = aiInput.trim();
    if (!text || aiBusy) return;
    setAiInput("");
    void runBoardTurn(text);
  }, [aiInput, aiBusy, runBoardTurn]);

  // 选区 → 帮我整理结构: describe the current selection (real ids the AI targets with
  // board_ops) and ask it to tidy them. No selection → a hint, not a turn.
  const organizeSelection = useCallback(() => {
    const api = excalidrawApiRef.current;
    if (!api || aiBusy) return;
    const selectedMap = api.getAppState().selectedElementIds;
    const ids = Object.keys(selectedMap).filter((id) => selectedMap[id]);
    if (ids.length === 0) {
      notifyInfo("请先在白板上选择要整理的元素");
      return;
    }
    const desc = describeSelection(
      api.getSceneElements() as unknown as BoardElement[],
      ids,
    );
    void runBoardTurn(organizeSelectionPrompt(desc));
  }, [aiBusy, runBoardTurn]);

  const stopBoardTurn = useCallback(() => {
    aiAbortRef.current?.abort();
  }, []);

  const commitTitle = useCallback(async () => {
    const next = title.trim();
    if (!board || !next || next === board.title) {
      setTitle(board?.title ?? "");
      return;
    }
    try {
      const updated = await renameBoard(boardId, next);
      setBoard((b) => (b ? { ...b, title: updated.title } : b));
    } catch {
      setTitle(board.title);
    }
  }, [title, board, boardId]);

  if (loadError) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">白板加载失败</p>
        <div className="flex gap-2">
          <Button variant="neutral" onClick={() => navigate("/whiteboard")}>
            返回列表
          </Button>
          <Button variant="primary" onClick={fetchBoard}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <IconButton
          aria-label="返回白板列表"
          onClick={() => navigate("/whiteboard")}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="未命名白板"
          aria-label="白板标题"
          className="min-w-0 max-w-xs flex-1 rounded-lg bg-transparent px-2 py-1 text-sm font-medium text-foreground outline-none hover:bg-accent focus:bg-accent"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {STATUS_TEXT[status]}
        </span>
      </header>

      {conflict ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-warning/10 px-3 py-2">
          <span className="text-xs text-foreground">
            此白板已在别处更新，为避免覆盖已暂停自动保存。
          </span>
          <Button
            variant="warning"
            size="sm"
            className="ml-auto"
            onClick={fetchBoard}
          >
            重新加载
          </Button>
        </div>
      ) : null}

      <div className="relative flex-1">
        {board && initialData ? (
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={(api) => {
              excalidrawApiRef.current = api;
            }}
            langCode="zh-CN"
            onChange={handleChange}
            theme={resolveDark(theme) ? "dark" : "light"}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="animate-spin text-muted-foreground" size={24} />
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-end gap-2 border-t border-border bg-card px-4 py-3">
        <Button
          variant="neutral"
          size="sm"
          onClick={organizeSelection}
          disabled={aiBusy || !board}
          className="shrink-0 gap-1.5"
        >
          <Sparkles size={15} />
          整理选区
        </Button>
        <textarea
          value={aiInput}
          onChange={(e) => {
            setAiInput(e.target.value);
            e.target.style.height = "0";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitOrder();
            }
          }}
          rows={1}
          disabled={aiBusy}
          placeholder="让 AI 在白板上作画 / 整理结构…（Enter 发送，Shift+Enter 换行）"
          aria-label="向 AI 下达白板指令"
          className="max-h-28 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
        />
        {aiBusy ? (
          <IconButton
            aria-label="停止"
            onClick={stopBoardTurn}
            className="size-10 rounded-xl"
          >
            <Square size={16} />
          </IconButton>
        ) : (
          <IconButton
            aria-label="下达指令"
            tone="primary"
            onClick={submitOrder}
            disabled={!aiInput.trim() || !board}
            className="size-10 rounded-xl"
          >
            <ArrowUp size={18} />
          </IconButton>
        )}
      </footer>
    </div>
  );
}
