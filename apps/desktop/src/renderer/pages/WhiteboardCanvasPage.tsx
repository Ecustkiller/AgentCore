import { CanvasShell } from "@/components/layout/CanvasShell";
import { Button } from "@/components/ui";
import {
  type BoardDetail,
  type BoardScene,
  getBoard,
  renameBoard,
  saveBoardScene,
} from "@/services/boards";
import {
  type SceneElement,
  type Viewport,
  WhiteboardCanvas,
  parseScene,
  serializeScene,
} from "@/whiteboard";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

/** One board's canvas. Loads the scene from the
 * backend into the self-built {@link WhiteboardCanvas}, autosaves it back (debounced) with
 * a CAS ``baseline`` so a stale tab/device never clobbers — on conflict autosave pauses and
 * offers a reload. Hand-drawn only; there is no AI command bar on the canvas. */
export function WhiteboardCanvasPage() {
  const { boardId = "" } = useParams();
  const navigate = useNavigate();

  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState("");

  // CAS version of the last load/save; sent as the next write's baseline.
  const versionRef = useRef(0);
  // Latest scene snapshot from the engine (the debounced flush reads this).
  // Tagged with the board the change came from so a stale timer cannot flush A onto B.
  const latestRef = useRef<{
    boardId: string;
    elements: SceneElement[];
    viewport: Viewport;
  } | null>(null);
  // Serialized elements of the last persisted/loaded state — skip no-op saves (and ignore
  // pan/zoom, which never reach onChange) so merely opening a board doesn't bump the version.
  const savedSceneRef = useRef("");
  const conflictRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation + source id: same-component route switch must not apply A onto B,
  // and persist must not write unless the route still matches the loaded board.
  const loadGenRef = useRef(0);
  const loadedSourceIdRef = useRef<string | null>(null);

  const fetchBoard = useCallback(() => {
    const requestedId = boardId;
    const gen = ++loadGenRef.current;
    loadedSourceIdRef.current = null;
    latestRef.current = null;
    versionRef.current = 0;
    savedSceneRef.current = "";
    setBoard(null);
    setTitle("");
    setLoadError(false);
    setStatus("idle");
    setConflict(false);
    conflictRef.current = false;
    getBoard(requestedId)
      .then((b) => {
        if (gen !== loadGenRef.current) return;
        versionRef.current = b.version;
        loadedSourceIdRef.current = b.id;
        setTitle(b.title);
        setBoard(b);
      })
      .catch(() => {
        if (gen !== loadGenRef.current) return;
        setLoadError(true);
      });
  }, [boardId]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  // Drop in-flight load + pending autosave when the route id changes (or unmount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 故意含 boardId，切换时跑 cleanup bump gen
  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      loadedSourceIdRef.current = null;
      latestRef.current = null;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [boardId]);

  const initialData = useMemo(() => {
    if (!board) return null;
    const parsed = parseScene(board.scene);
    savedSceneRef.current = JSON.stringify(parsed.elements);
    return parsed;
  }, [board]);

  // CAS-write the scene (debounced autosave). Returns the new version, or null on
  // conflict/error. A no-op (elements unchanged) returns the current version.
  const persistScene = useCallback(
    async (
      elements: SceneElement[],
      viewport: Viewport,
    ): Promise<number | null> => {
      const sourceId = loadedSourceIdRef.current;
      if (!sourceId || sourceId !== boardId) return null;
      const key = JSON.stringify(elements);
      if (key === savedSceneRef.current) return versionRef.current;
      setStatus("saving");
      try {
        const scene = serializeScene(
          elements,
          viewport,
        ) as unknown as BoardScene;
        const res = await saveBoardScene(sourceId, scene, versionRef.current);
        if (loadedSourceIdRef.current !== sourceId) {
          return res.conflict ? null : res.version;
        }
        if (res.conflict) {
          conflictRef.current = true;
          setConflict(true);
          setStatus("idle");
          return null;
        }
        versionRef.current = res.version;
        savedSceneRef.current = key;
        setStatus("saved");
        return res.version;
      } catch {
        if (loadedSourceIdRef.current !== sourceId) return null;
        setStatus("error");
        return null;
      }
    },
    [boardId],
  );

  const flush = useCallback(async () => {
    const snap = latestRef.current;
    if (!snap || conflictRef.current) return;
    if (
      snap.boardId !== boardId ||
      snap.boardId !== loadedSourceIdRef.current
    ) {
      return;
    }
    await persistScene(snap.elements, snap.viewport);
  }, [persistScene, boardId]);

  const handleChange = useCallback(
    (elements: SceneElement[], viewport: Viewport) => {
      latestRef.current = { boardId, elements, viewport };
      if (conflictRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), 1500);
    },
    [flush, boardId],
  );

  const commitTitle = useCallback(async () => {
    const next = title.trim();
    if (!board || !next || next === board.title) {
      setTitle(board?.title ?? "");
      return;
    }
    if (board.id !== boardId || loadedSourceIdRef.current !== boardId) {
      setTitle(board.title);
      return;
    }
    try {
      const updated = await renameBoard(boardId, next);
      if (loadedSourceIdRef.current !== boardId) return;
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
    <CanvasShell
      backAriaLabel="返回白板列表"
      onBack={() => navigate("/whiteboard")}
      title={
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
      }
      status={STATUS_TEXT[status]}
      banner={
        conflict ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-3 py-2">
            <span className="text-xs text-foreground">
              此白板已在别处更新，为避免覆盖已暂停自动保存。
            </span>
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              onClick={fetchBoard}
            >
              重新加载
            </Button>
          </div>
        ) : null
      }
    >
      {board && initialData ? (
        <WhiteboardCanvas
          key={board.id}
          initialElements={initialData.elements}
          initialViewport={initialData.viewport}
          onChange={handleChange}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="animate-spin text-muted-foreground" size={24} />
        </div>
      )}
    </CanvasShell>
  );
}
