import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage } from "@/services/api";
import { setUserPassword } from "@/services/adminUsers";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

export function SetPasswordDialog({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const formId = useId();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [forceChange, setForceChange] = useState(true);
  const [saving, setSaving] = useState(false);

  const localError =
    next.length > 0 && next.length < 8
      ? "新密码至少需要 8 个字符"
      : confirm.length > 0 && next !== confirm
        ? "两次输入的密码不一致"
        : null;
  const canSave = next.length >= 8 && next === confirm && !saving;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      await setUserPassword(userId, {
        new_password: next,
        force_change: forceChange,
      });
      toast.success("密码已设置，该用户所有设备已登出");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      title="设置密码"
      description={`为 @${username} 指定新密码`}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          {/* Lives outside the <form> in the dialog footer, so it submits by id. */}
          <Button type="submit" form={formId} size="sm" disabled={!canSave}>
            {saving && <Spinner />}
            确认设置
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col gap-3"
      >
        <p className="text-sm text-muted-foreground">
          将立即
          <span className="font-medium text-foreground">登出该用户所有设备</span>
          ，原密码作废。请通过安全渠道把新密码转交本人。
        </p>

        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            新密码（至少 8 位）
          </span>
          <Input
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
            disabled={saving}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">确认新密码</span>
          <Input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            disabled={saving}
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={forceChange}
            onChange={(e) => setForceChange(e.target.checked)}
            disabled={saving}
            className="size-4 accent-primary"
          />
          要求用户首次登录后修改密码
        </label>

        {localError && <p className="text-xs text-destructive">{localError}</p>}
      </form>
    </Dialog>
  );
}
