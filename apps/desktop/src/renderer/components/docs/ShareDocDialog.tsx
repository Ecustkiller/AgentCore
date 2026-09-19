import { Button, IconButton } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { formatMessageTime } from "@/lib/format";
import { notifyError, notifySuccess } from "@/lib/toast";
import { createDocShare, listDocShares, revokeDocShare } from "@/services/docs";
import {
  type CreateShareOptions,
  type Share,
  shareLink,
} from "@/services/sharing";
import { Check, Copy, Link2, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ShareExpiryChoice =
  | NonNullable<CreateShareOptions["expires_in_days"]>
  | "never";

const EXPIRY_OPTIONS: { value: ShareExpiryChoice; label: string }[] = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: "never", label: "永久" },
];

/**
 * Publish / update / revoke the public 文档 page. First publish mints a stable
 * `/shared/<id>`; later publishes overwrite that snapshot. Live draft does not
 * auto-follow. Flush pending edits before every publish.
 */
export function ShareDocDialog({
  docId,
  title,
  open,
  onOpenChange,
  onFlush,
}: {
  docId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFlush: () => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ShareDialogBody
          key={docId}
          docId={docId}
          title={title}
          onFlush={onFlush}
        />
      ) : null}
    </Dialog>
  );
}

function ShareDialogBody({
  docId,
  title,
  onFlush,
}: {
  docId: string;
  title: string;
  onFlush: () => Promise<boolean>;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [expiry, setExpiry] = useState<ShareExpiryChoice>(30);

  const reload = useCallback(async () => {
    try {
      setShares(await listDocShares(docId));
    } catch (e) {
      notifyError(e, "加载公开页失败");
      setShares([]);
    }
  }, [docId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const published = (shares ?? []).length > 0;

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const flushed = await onFlush();
      if (!flushed) {
        notifyError("保存失败，无法按当前内容发布");
        return;
      }
      const options: CreateShareOptions | undefined = published
        ? undefined
        : { expires_in_days: expiry === "never" ? null : expiry };
      const share = await createDocShare(docId, options);
      await reload();
      await copyText(shareLink(share));
      notifySuccess(published ? "客户页已更新" : "已发布，链接已复制");
    } catch (e) {
      notifyError(e, published ? "更新发布失败" : "发布失败");
    } finally {
      setPublishing(false);
    }
  };

  const handleCopy = async (share: Share) => {
    if (!(await copyText(shareLink(share)))) notifyError("复制失败");
  };

  const handleRevoke = async (share: Share) => {
    setShares((prev) => prev?.filter((s) => s.id !== share.id) ?? null);
    try {
      await revokeDocShare(docId, share.id);
    } catch (e) {
      notifyError(e, "撤销失败");
      setShares((prev) => [share, ...(prev ?? [])]);
    }
  };

  return (
    <DialogContent size="md">
      <DialogHeader>
        <DialogTitle>发布文档</DialogTitle>
        <DialogDescription>
          {title ? `「${title}」` : "该文档"}
          的只读公开页。网址不变；客户看到的是上次发布的内容，编辑器里未发布的改动不会出现。可随时撤销。
        </DialogDescription>
      </DialogHeader>

      {published ? null : (
        <DialogBody className="pb-2">
          <p className="mb-2 text-xs text-muted-foreground">链接有效期</p>
          <div className="flex flex-wrap gap-2">
            {EXPIRY_OPTIONS.map((opt) => (
              <Button
                key={String(opt.value)}
                type="button"
                variant={expiry === opt.value ? "primary" : "neutral"}
                className="h-8 px-3 text-xs"
                disabled={publishing}
                onClick={() => setExpiry(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </DialogBody>
      )}

      <DialogBody className="max-h-[40vh]">
        {shares === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            加载中…
          </div>
        ) : shares.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            还没有公开页。点击下方「发布」生成一个客户能打开的网址。
          </p>
        ) : (
          <ul className="flex flex-col gap-2 py-1">
            {shares.map((share) => (
              <li
                key={share.id}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
              >
                <Link2 size={14} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">
                    {shareLink(share)}
                  </div>
                  {share.title && share.title !== title ? (
                    <div
                      className="truncate text-xs text-muted-foreground"
                      title={share.title}
                    >
                      发布标题：{share.title}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    {formatMessageTime(share.created_at)} 发布
                    {share.expires_at
                      ? ` · ${formatMessageTime(share.expires_at)} 过期`
                      : " · 永不过期"}
                  </div>
                </div>
                <SimpleTooltip label="复制链接">
                  <IconButton
                    aria-label="复制链接"
                    onClick={() => void handleCopy(share)}
                  >
                    <Copy size={14} />
                  </IconButton>
                </SimpleTooltip>
                <SimpleTooltip label="撤销公开页">
                  <IconButton
                    aria-label="撤销公开页"
                    onClick={() => void handleRevoke(share)}
                    className="hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </SimpleTooltip>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>

      <DialogFooter>
        <Button
          className="h-9 px-4"
          disabled={publishing || shares === null}
          icon={
            publishing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )
          }
          onClick={() => void handlePublish()}
        >
          {published ? "更新发布" : "发布"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
