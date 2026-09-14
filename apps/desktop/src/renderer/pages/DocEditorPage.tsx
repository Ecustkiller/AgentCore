import { ShareDocDialog } from "@/components/docs/ShareDocDialog";
import { CanvasShell } from "@/components/layout/CanvasShell";
import {
  MarkdownSourceEditor,
  type MarkdownSourceEditorHandle,
} from "@/components/markdown/MarkdownSourceEditor";
import { SourceToolbar } from "@/components/markdown/sourceToolbar";
import { Button } from "@/components/ui";
import { type DocBody, parseDocBody } from "@/lib/docBody";
import {
  type DocDetail,
  getDoc,
  renameDoc,
  saveDocBody,
} from "@/services/docs";
import { Link2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

function serializeBody(body: DocBody): string {
  return body.markdown;
}

export function DocEditorPage() {
  const { docId = "" } = useParams();
  const navigate = useNavigate();

  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [editorGen, setEditorGen] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [conflict, setConflict] = useState(false);
  const [title, setTitle] = useState("");

  const [shareOpen, setShareOpen] = useState(false);

  const versionRef = useRef(0);
  const savedRef = useRef("");
  const latestRef = useRef<string | null>(null);
  const conflictRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistInflight = useRef<Promise<boolean> | null>(null);
  const loadGenRef = useRef(0);
  const loadedSourceIdRef = useRef<string | null>(null);
  const editorRef = useRef<MarkdownSourceEditorHandle>(null);

  const fetchDoc = useCallback(() => {
    const requestedId = docId;
    const gen = ++loadGenRef.current;
    loadedSourceIdRef.current = null;
    latestRef.current = null;
    versionRef.current = 0;
    savedRef.current = "";
    setDoc(null);
    setMarkdown("");
    setTitle("");
    setLoadError(false);
    setStatus("idle");
    setConflict(false);
    setShareOpen(false);
    conflictRef.current = false;
    getDoc(requestedId)
      .then((d) => {
        if (gen !== loadGenRef.current) return;
        const parsed = parseDocBody(d.body);
        versionRef.current = d.version;
        loadedSourceIdRef.current = d.id;
        savedRef.current = serializeBody(parsed);
        latestRef.current = parsed.markdown;
        setTitle(d.title);
        setMarkdown(parsed.markdown);
        setDoc(d);
        setEditorGen((n) => n + 1);
      })
      .catch(() => {
        if (gen !== loadGenRef.current) return;
        setLoadError(true);
      });
  }, [docId]);

  useEffect(() => {
    fetchDoc();
    return () => {
      loadGenRef.current += 1;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // persist 同步读 loadedSourceIdRef；先冲刷再清空，否则离开页丢掉未到 800ms 的按键。
      void flushRef.current();
      loadedSourceIdRef.current = null;
      latestRef.current = null;
    };
  }, [fetchDoc]);

  const persist = useCallback(
    async (next: string): Promise<boolean> => {
      const sourceId = loadedSourceIdRef.current;
      if (!sourceId || sourceId !== docId) return false;

      const run = async (): Promise<boolean> => {
        const body: DocBody = { markdown: next };
        const key = serializeBody(body);
        if (key === savedRef.current) return true;
        setStatus("saving");
        try {
          const res = await saveDocBody(sourceId, body, versionRef.current);
          if (loadedSourceIdRef.current !== sourceId) return false;
          if (res.conflict) {
            conflictRef.current = true;
            setConflict(true);
            setStatus("idle");
            return false;
          }
          versionRef.current = res.version;
          savedRef.current = key;
          setStatus("saved");
          return true;
        } catch {
          if (loadedSourceIdRef.current !== sourceId) return false;
          setStatus("error");
          return false;
        }
      };

      const queued = persistInflight.current
        ? persistInflight.current.then(run, run)
        : run();
      persistInflight.current = queued;
      void queued.finally(() => {
        if (persistInflight.current === queued) persistInflight.current = null;
      });
      return queued;
    },
    [docId],
  );

  const scheduleSave = useCallback(
    (next: string) => {
      latestRef.current = next;
      if (conflictRef.current) return;
      if (doc && !doc.can_write) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const snap = latestRef.current;
        if (snap == null) return;
        void persist(snap);
      }, 800);
    },
    [persist, doc],
  );

  const commitTitle = useCallback(async () => {
    const next = title.trim();
    if (!doc || !next || next === doc.title) {
      setTitle(doc?.title ?? "");
      return;
    }
    if (doc.id !== docId || loadedSourceIdRef.current !== docId) {
      setTitle(doc.title);
      return;
    }
    if (!doc.can_write) {
      setTitle(doc.title);
      return;
    }
    try {
      const updated = await renameDoc(docId, next);
      if (loadedSourceIdRef.current !== docId) return;
      setDoc((d) => (d ? { ...d, title: updated.title } : d));
    } catch {
      setTitle(doc.title);
    }
  }, [title, doc, docId]);

  const flushPending = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snap = editorRef.current?.getValue() ?? latestRef.current;
    const bodyP = snap == null ? Promise.resolve(true) : persist(snap);
    await commitTitle();
    return bodyP;
  }, [commitTitle, persist]);

  const flushRef = useRef(flushPending);
  flushRef.current = flushPending;

  if (loadError) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">文档加载失败</p>
        <div className="flex gap-2">
          <Button variant="neutral" onClick={() => navigate("/docs")}>
            返回列表
          </Button>
          <Button variant="primary" onClick={fetchDoc}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CanvasShell
      backAriaLabel="返回文档列表"
      onBack={() => navigate("/docs")}
      title={
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="未命名文档"
          aria-label="文档标题"
          readOnly={!doc?.can_write}
          className="min-w-0 max-w-xs flex-1 rounded-lg bg-transparent px-2 py-1 text-sm font-medium text-foreground outline-none hover:bg-accent focus:bg-accent read-only:hover:bg-transparent read-only:focus:bg-transparent"
        />
      }
      status={STATUS_TEXT[status]}
      actions={
        doc?.can_write ? (
          <Button
            variant="neutral"
            icon={<Link2 size={14} />}
            onClick={() => setShareOpen(true)}
          >
            分享
          </Button>
        ) : null
      }
      banner={
        conflict ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-3 py-2">
            <span className="text-xs text-foreground">
              此文档已在别处更新，为避免覆盖已暂停自动保存。
            </span>
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              onClick={fetchDoc}
            >
              重新加载
            </Button>
          </div>
        ) : null
      }
    >
      {doc ? (
        <div className="absolute inset-0 flex flex-col">
          {doc.can_write ? null : (
            <p className="shrink-0 px-6 pt-4 text-sm text-muted-foreground">
              只读成员不能改这份文档。
            </p>
          )}
          {doc.can_write ? (
            <SourceToolbar
              getView={() => editorRef.current?.getView() ?? null}
            />
          ) : null}
          <MarkdownSourceEditor
            key={`${doc.id}-${editorGen}`}
            ref={editorRef}
            initialDoc={markdown}
            editable={doc.can_write}
            onChange={scheduleSave}
            onSave={() => {
              const snap = editorRef.current?.getValue() ?? latestRef.current;
              if (snap == null) return;
              void persist(snap);
            }}
            className="min-h-0 flex-1 overflow-hidden"
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="animate-spin text-muted-foreground" size={24} />
        </div>
      )}
      {doc?.can_write ? (
        <ShareDocDialog
          docId={doc.id}
          title={title || doc.title}
          open={shareOpen}
          onOpenChange={setShareOpen}
          onFlush={flushPending}
        />
      ) : null}
    </CanvasShell>
  );
}
