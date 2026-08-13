import type { WorkspaceEol } from "@/api/workspace";
import { Modal } from "@/components/Modal";
import type { FileBrowserOps } from "@/components/fileBrowser/ops";
// 云工作区文本文件的在线编辑（mtime CAS，冲突诚实提示）。
//
// 保存走后端条件写：打开时拿到的 mtime 是基线，AI 或另一台设备在这期间改过同一个文件，
// 后端返回 conflict 而**不写**。那时必须让用户看见「你的修改没保存」并自己裁决——
// 静默覆盖别人的改动是这条路上唯一不能出现的结局。
import { useCallback, useEffect, useState } from "react";

type Baseline = { mtimeMs: number; eol: WorkspaceEol };

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

export function FileTextEditor({
  path,
  name,
  ops,
  onClose,
  onSaved,
}: {
  path: string;
  name: string;
  ops: Pick<FileBrowserOps, "readForEdit" | "writeText">;
  onClose: () => void;
  /** A successful write — the preview shows `text` and the tree refreshes (mtime moved). */
  onSaved: (text: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [baseline, setBaseline] = useState<Baseline>({
    mtimeMs: 0,
    eol: "lf",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 冲突未决：存的是**云端当前版本**，用户选「仍然覆盖」时它就是新基线。
  const [conflictMtimeMs, setConflictMtimeMs] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = load.kind === "ready" && text !== saved;

  const reload = useCallback(async () => {
    setLoad({ kind: "loading" });
    setSaveError(null);
    setConflictMtimeMs(null);
    try {
      const doc = await ops.readForEdit(path);
      setText(doc.text);
      setSaved(doc.text);
      setBaseline({ mtimeMs: doc.mtimeMs, eol: doc.eol });
      setLoad({ kind: "ready" });
    } catch (e) {
      setLoad({
        kind: "error",
        message: e instanceof Error ? e.message : "打开编辑失败",
      });
    }
  }, [ops, path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (force: boolean) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setStatus(null);
    const body = text;
    try {
      const result = await ops.writeText(path, {
        content: body,
        baselineMtimeMs: force
          ? (conflictMtimeMs ?? baseline.mtimeMs)
          : baseline.mtimeMs,
        eol: baseline.eol,
      });
      if (result.ok) {
        setBaseline((b) => ({ ...b, mtimeMs: result.mtimeMs }));
        setSaved(body);
        setConflictMtimeMs(null);
        setStatus("已保存");
        onSaved(body);
      } else {
        // 未写入。留住用户正文，把云端版本记成「仍然覆盖」时要用的基线。
        setConflictMtimeMs(result.mtimeMs);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm("有未保存的修改，确定离开编辑？")) return;
    onClose();
  };

  return (
    <Modal className="viewer" onClose={close} label={`编辑 ${name}`}>
      <header className="bar viewer-bar">
        <button type="button" className="link" onClick={close}>
          ← 取消
        </button>
        <span className="viewer-name" title={name}>
          {name}
        </span>
        <span className="bar-right viewer-actions">
          <button
            type="button"
            className="link"
            disabled={load.kind !== "ready" || saving || !dirty}
            onClick={() => void save(false)}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </span>
      </header>

      {conflictMtimeMs !== null && (
        <div className="file-editor-conflict">
          <p className="file-editor-conflict-msg">
            云端的这个文件已经被改过（可能是 AI 刚写过），
            <strong>你这次的修改还没有保存</strong>。
          </p>
          <div className="file-editor-conflict-actions">
            <button
              type="button"
              className="link"
              disabled={saving}
              onClick={() => void reload()}
            >
              放弃我的修改，载入最新版
            </button>
            <button
              type="button"
              className="dialog-danger"
              disabled={saving}
              onClick={() => void save(true)}
            >
              {saving ? "覆盖中…" : "仍然覆盖"}
            </button>
          </div>
        </div>
      )}

      {saveError && <p className="error hint file-editor-note">{saveError}</p>}
      {status && !dirty && conflictMtimeMs === null && (
        <p className="muted hint file-editor-note">{status}</p>
      )}

      <div className="viewer-body file-editor-body">
        {load.kind === "loading" && <p className="muted hint">加载中…</p>}
        {load.kind === "error" && <p className="error hint">{load.message}</p>}
        {load.kind === "ready" && (
          <textarea
            className="file-editor-text"
            value={text}
            aria-label={`编辑 ${name}`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setText(e.target.value);
              setStatus(null);
            }}
          />
        )}
      </div>
    </Modal>
  );
}
