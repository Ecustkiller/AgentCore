import { Modal } from "@/components/Modal";
import { entryNameError } from "@/components/fileBrowser/paths";
import { useState } from "react";

/** Name a new folder for the current directory (creation itself is the caller's op). */
export function NewFolderDialog({
  parentLabel,
  busy,
  error,
  onClose,
  onCreate,
}: {
  /** Where it will be created, shown so the user knows the target ("根目录" at root). */
  parentLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const nameError = entryNameError(name);
  const submit = () => {
    if (busy || nameError) return;
    onCreate(name.trim());
  };
  return (
    <Modal className="dialog" onClose={onClose} label="新建文件夹">
      <div className="dialog-title">新建文件夹</div>
      <div className="dialog-msg">建在「{parentLabel}」下</div>
      <input
        className="dialog-input"
        value={name}
        // biome-ignore lint/a11y/noAutofocus: a naming dialog should focus its field
        autoFocus
        aria-label="文件夹名称"
        placeholder="文件夹名称"
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      {name.trim() && nameError && <p className="error hint">{nameError}</p>}
      {error && <p className="error hint">{error}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button type="button" disabled={busy || !!nameError} onClick={submit}>
          {busy ? "创建中…" : "创建"}
        </button>
      </div>
    </Modal>
  );
}
