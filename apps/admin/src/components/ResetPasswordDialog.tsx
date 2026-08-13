import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage } from "@/services/api";
import { resetUserPassword } from "@/services/adminUsers";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// Two-phase: 确认 (the action signs the user out of every device) → 展示 the
// one-off password. The temp password is returned exactly once by the backend,
// so the 展示 phase is the only chance to capture it — no re-fetch path exists.
type Phase = "confirm" | "done";

export function ResetPasswordDialog({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [saving, setSaving] = useState(false);
  const [temp, setTemp] = useState("");
  const [copied, setCopied] = useState(false);

  const handleReset = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await resetUserPassword(userId);
      setTemp(res.temporary_password);
      setPhase("done");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(temp);
      setCopied(true);
      toast.success("临时密码已复制");
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  const done = phase === "done";

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      title="重置密码"
      description={
        done
          ? "请立即复制并通过安全渠道转交用户"
          : `为 @${username} 生成一个一次性临时密码`
      }
      // A stray click on the backdrop would destroy a password that cannot be
      // fetched again, so the 展示 phase only closes through a deliberate action.
      dismissOnOverlay={!done}
      footer={
        done ? (
          <Button size="sm" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleReset()}
              disabled={saving}
            >
              {saving && <Spinner />}
              确认重置
            </Button>
          </>
        )
      }
    >
      {done ? (
        <>
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-xs">
            此密码仅显示这一次，关闭后无法再次查看。
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 select-all rounded-lg border border-border bg-muted/40 px-4 py-3 text-center font-mono text-base text-foreground">
              {temp}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopy()}
              aria-label="复制临时密码"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          将为该账号生成新的临时密码，并
          <span className="font-medium text-foreground">立即登出其所有设备</span>
          。原密码作废，用户需用临时密码重新登录；在你把新密码交给本人之前，该账号处于无法登录的状态。
        </p>
      )}
    </Dialog>
  );
}
