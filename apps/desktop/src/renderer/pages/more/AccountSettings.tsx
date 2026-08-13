import {
  SettingField,
  SettingRow,
  SettingsFormMessage,
  SettingsSection,
  SettingsStack,
} from "@/components/settings";
import { Button, Card, ConfirmDialog, Input } from "@/components/ui";
import { errMsg } from "@/lib/errMsg";
import { notifySuccess } from "@/lib/toast";
import {
  changePassword,
  deleteAccount,
  deleteAvatar,
  updateProfile,
  uploadAvatar,
} from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { LoginSessionsSection } from "./LoginSessionsSection";
import { SettingsHeader } from "./SettingsHeader";

// Mirror of the server's avatar_upload_max_bytes so an oversized pick fails fast,
// before a pointless round-trip.
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 账户设置 (/more/account) — self-service identity management.
 *
 * Sections: 个人资料 / 修改密码 / 登录设备 / 危险区域 (注销).
 */
export function AccountSettings() {
  return (
    <div>
      <SettingsHeader
        title="账户设置"
        description="管理你的个人资料、登录密码、登录设备与账户。"
      />
      <SettingsStack>
        <AvatarSection />
        <ProfileSection />
        <PasswordSection />
        <LoginSessionsSection />
        <DangerSection />
      </SettingsStack>
    </div>
  );
}

/** 头像: upload a square image or remove; backend re-encodes to square WebP. */
function AvatarSection() {
  const user = useAuthStore((s) => s.user);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = (user?.displayName || user?.username || "?")
    .charAt(0)
    .toUpperCase();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file after an error
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError("图片不能超过 5 MB");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAuthenticated(await uploadAvatar(file));
    } catch (err) {
      setError(errMsg(err, "上传失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      setAuthenticated(await deleteAvatar());
    } catch (err) {
      setError(errMsg(err, "操作失败，请重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="头像" description="上传清晰的正方形图片效果最佳。">
      <Card className="flex items-center gap-4 p-4">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xl font-medium text-muted-foreground">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt="头像"
              className="size-16 object-cover"
            />
          ) : (
            initial
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="md"
              disabled={busy}
              icon={
                busy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : undefined
              }
              onClick={() => inputRef.current?.click()}
            >
              上传头像
            </Button>
            {user?.avatarUrl && (
              <Button
                variant="neutral"
                size="md"
                disabled={busy}
                onClick={() => void remove()}
              >
                移除
              </Button>
            )}
          </div>
          <SettingsFormMessage>{error}</SettingsFormMessage>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void onFile(e)}
        />
      </Card>
    </SettingsSection>
  );
}

/** 个人资料: edit display name + email; on save, refresh the auth store. */
function ProfileSection() {
  const user = useAuthStore((s) => s.user);
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = displayName.trim();
  const trimmedEmail = email.trim();
  const dirty =
    trimmedName !== (user?.displayName ?? "") ||
    trimmedEmail !== (user?.email ?? "");
  const canSave = dirty && trimmedName.length > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile({
        displayName: trimmedName,
        // empty clears the (nullable) email server-side
        email: trimmedEmail,
      });
      setAuthenticated(updated);
      setDisplayName(updated.displayName);
      setEmail(updated.email ?? "");
    } catch (e) {
      setError(errMsg(e, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="个人资料"
      description="显示名会展示给团队成员；邮箱用于后续找回密码（可选）。"
    >
      <Card className="space-y-3 p-4">
        <SettingField label="用户名" htmlFor="account-profile-username">
          <Input
            id="account-profile-username"
            value={user?.username ?? ""}
            disabled
          />
        </SettingField>
        <SettingField label="显示名" htmlFor="account-profile-display-name">
          <Input
            id="account-profile-display-name"
            value={displayName}
            maxLength={200}
            placeholder="你的显示名"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </SettingField>
        <SettingField label="邮箱（可选）" htmlFor="account-profile-email">
          <Input
            id="account-profile-email"
            type="email"
            value={email}
            maxLength={255}
            placeholder="you@example.com"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </SettingField>
        <SettingsFormMessage>{error}</SettingsFormMessage>
        <div className="flex justify-end">
          <Button
            size="md"
            disabled={!canSave}
            icon={
              saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : undefined
            }
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </Card>
    </SettingsSection>
  );
}

/** 修改密码: current + new + confirm; the backend keeps this session alive. */
function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  // Client-side mirror of the server policy, so obvious mistakes never round-trip.
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSave =
    current.length > 0 && next.length >= 8 && next === confirm && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      reset();
      // 其他设备被登出这件事在本机不可见，静默会让用户无法确认是否生效。
      notifySuccess("密码已更新", { description: "其他设备需要重新登录。" });
    } catch (e) {
      setError(errMsg(e, "修改失败，请重试"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="修改密码"
      description="修改后，除当前设备外的所有登录都会失效。"
    >
      <Card className="space-y-3 p-4">
        <SettingField label="当前密码" htmlFor="account-password-current">
          <Input
            id="account-password-current"
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </SettingField>
        <SettingField
          label="新密码（至少 8 位）"
          htmlFor="account-password-new"
          error={tooShort ? "新密码至少需要 8 个字符" : null}
        >
          <Input
            id="account-password-new"
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </SettingField>
        <SettingField
          label="确认新密码"
          htmlFor="account-password-confirm"
          error={mismatch ? "两次输入的新密码不一致" : null}
        >
          <Input
            id="account-password-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </SettingField>
        <SettingsFormMessage>{error}</SettingsFormMessage>
        <div className="flex justify-end">
          <Button
            size="md"
            disabled={!canSave}
            icon={
              saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : undefined
            }
            onClick={() => void save()}
          >
            更新密码
          </Button>
        </div>
      </Card>
    </SettingsSection>
  );
}

/** 危险区域: irreversible account deletion behind a password-confirm dialog. */
function DangerSection() {
  const [open, setOpen] = useState(false);

  return (
    <SettingsSection
      title="危险区域"
      tone="danger"
      description="注销后账户将被停用并匿名化，且无法恢复。"
    >
      <SettingRow
        className="border-destructive/40 bg-destructive/5"
        label="注销账户"
        description="永久停用此账户，并释放用户名以供重新注册。"
        control={
          <Button
            variant="danger"
            size="md"
            className="shrink-0"
            onClick={() => setOpen(true)}
          >
            注销账户
          </Button>
        }
      />
      <DeleteAccountDialog open={open} onOpenChange={setOpen} />
    </SettingsSection>
  );
}

/** Password-confirm modal for注销; on success drops the app back to login. */
function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      // Account gone → drop to the login screen (AuthGate renders it on this).
      useAuthStore.getState().setUnauthenticated();
    } catch (e) {
      setError(errMsg(e, "注销失败，请重试"));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassword("");
          setError(null);
        }
        onOpenChange(next);
      }}
      title="确认注销账户"
      description="此操作不可撤销。账户将被永久停用并匿名化，相关对话也会被删除。请输入密码以确认。"
      confirmLabel="确认注销"
      tone="danger"
      busy={busy}
      confirmDisabled={password.length === 0}
      onConfirm={() => void confirm()}
    >
      <Input
        className="w-full"
        type="password"
        value={password}
        aria-label="当前密码"
        placeholder="当前密码"
        autoComplete="current-password"
        onChange={(e) => {
          setError(null);
          setPassword(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && password && !busy) void confirm();
        }}
      />
      <SettingsFormMessage className="mt-2">{error}</SettingsFormMessage>
    </ConfirmDialog>
  );
}
