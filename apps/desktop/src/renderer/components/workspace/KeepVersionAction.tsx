import { Button, Input } from "@/components/ui";
import type { VersionSource } from "@/components/workspace/changesTimeline";
import { notifyError, notifySuccess } from "@/lib/toast";
import { createLocalVersion } from "@/services/localWorkspaceVersions";
import { createSnapshot } from "@/services/workspace";
import { wsCreateSnapshot } from "@/services/workspaces";
import { Bookmark, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * 「留版本」入口 —— 折叠成一个按钮，展开才占一行输入。
 * 改动 tab 大多数时候在看 diff，常驻输入框是噪音；空态则由它承担唯一入口。
 *
 * 云端写快照 API、本机写盘上版本区，对用户是同一个动作，所以是同一个按钮。
 */
export function KeepVersionAction({
  source,
  onCreated,
  emphasis = false,
}: {
  source: VersionSource;
  onCreated: () => void;
  /** 空态：这是面板上唯一的行动点，用主按钮。 */
  emphasis?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmed = label.trim();

  const close = () => {
    setOpen(false);
    setLabel("");
  };

  const submit = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      if (source.origin === "local") {
        await createLocalVersion(source.target, trimmed);
      } else if (source.origin === "cloudWs") {
        await wsCreateSnapshot(source.wsId, trimmed);
      } else {
        await createSnapshot(source.conversationId, trimmed);
      }
      notifySuccess(`已留版本「${trimmed}」`);
      close();
      onCreated();
    } catch (e) {
      notifyError(e, "留版本失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant={emphasis ? "primary" : "neutral"}
        icon={<Bookmark size={13} />}
        aria-label="留版本"
        title="为当前工作区留一个命名版本，之后随时回到这里"
        onClick={() => setOpen(true)}
      >
        留版本
      </Button>
    );
  }

  return (
    <div className="flex w-full items-center gap-1.5">
      <Input
        autoFocus
        aria-label="版本名"
        placeholder="版本名"
        maxLength={200}
        value={label}
        disabled={saving}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") close();
        }}
        className="h-7 min-w-0 flex-1 text-xs"
      />
      <Button
        disabled={!trimmed || saving}
        onClick={() => void submit()}
        icon={saving ? <Loader2 size={13} className="animate-spin" /> : null}
      >
        保存
      </Button>
      <Button variant="ghost" disabled={saving} onClick={close}>
        取消
      </Button>
    </div>
  );
}
