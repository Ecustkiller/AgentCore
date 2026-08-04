import { Button, Input } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { notifyActionError, notifySuccess } from "@/lib/toast";
import { ApiError } from "@/services/api";
import { wsCloneRepo } from "@/services/workspaces";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

/**
 * Cloud-workspace shallow clone dialog (G3). Calls
 * ``POST /v1/workspaces/{ws_id}/clone`` — http(s) only; private repos need
 * account PAT under 设置 → Git 凭据.
 */
export function CloneRepoDialog({
  open,
  onOpenChange,
  wsId,
  onCloned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  onCloned?: (path: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [dest, setDest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setRepoUrl("");
    setDest("");
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    const url = repoUrl.trim();
    if (!url) {
      setError("请填写仓库地址");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError("仅支持 http(s) 地址（不支持 ssh / file）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = await wsCloneRepo(wsId, {
        repoUrl: url,
        dest: dest.trim() || null,
      });
      notifySuccess(`已克隆到 ${path}`);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      onCloned?.(path);
      onOpenChange(false);
      reset();
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? (e.serverMessage ?? "克隆失败")
          : "克隆失败，请重试";
      setError(msg);
      if (/凭据|PAT|401|403|Authentication|authentication/i.test(msg)) {
        notifyActionError("私仓需要凭据", e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>克隆仓库</DialogTitle>
          <DialogDescription>
            浅克隆到当前云工作区（仅 http(s)）。私仓请先在{" "}
            <Link
              to="/more/git"
              className="text-foreground underline underline-offset-2"
              onClick={() => onOpenChange(false)}
            >
              设置 → Git 凭据
            </Link>{" "}
            配置 PAT。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="clone-url">
              仓库 URL
            </label>
            <Input
              id="clone-url"
              placeholder="https://github.com/owner/repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="clone-dest">
              目标目录（可选）
            </label>
            <Input
              id="clone-dest"
              placeholder="默认取仓库名"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="neutral"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            克隆
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
