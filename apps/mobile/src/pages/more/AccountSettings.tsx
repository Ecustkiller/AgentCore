// 账户设置 (/more/account) — profile / password / avatar / 注销 (mirrors desktop).
//
// Four independent sections, each posting on its own. No global auth store on mobile, so
// the page loads `me()` on open and keeps the user in local state, re-syncing it after
// each mutation that returns the refreshed user.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type User, logout, me } from "@/api/auth";
import {
  AVATAR_MAX_BYTES,
  changePassword,
  deleteAccount,
  deleteAvatar,
  updateProfile,
  uploadAvatar,
} from "@/api/account";
import { getTokens } from "@/api/client";
import { Avatar } from "@/pages/more/Avatar";
import "@/pages/more/more.css";

export function AccountSettings() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    me()
      .then((u) => !cancelled && setUser(u))
      .catch(() => {
        if (!getTokens()) navigate("/login", { replace: true });
        else if (!cancelled) setError("加载账户失败");
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="link" onClick={() => navigate("/more")}>
          ← 设置
        </button>
        <span>账户设置</span>
        <span style={{ width: 44 }} />
      </header>

      <div className="settings-body">
        {error && <p className="error hint">{error}</p>}
        {user && (
          <>
            <AvatarSection user={user} onUser={setUser} />
            <ProfileSection user={user} onUser={setUser} />
            <PasswordSection />
            <DangerSection
              onDeleted={async () => {
                await logout().catch(() => {});
                navigate("/login", { replace: true });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  danger,
  children,
}: {
  title: string;
  note?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <h2 className={`section-title${danger ? " danger" : ""}`}>{title}</h2>
      {note && <p className="section-note">{note}</p>}
      <div className={`section-card${danger ? " danger" : ""}`}>{children}</div>
    </section>
  );
}

function AvatarSection({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
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
      onUser(await uploadAvatar(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      onUser(await deleteAvatar());
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="头像" note="建议使用清晰的正方形图片。">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Avatar user={user} size={64} />
        <div className="btn-row">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "处理中…" : "上传头像"}
          </button>
          {user.avatar_url && (
            <button type="button" className="btn-outline" onClick={() => void remove()} disabled={busy}>
              移除
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => void onFile(e)}
        />
      </div>
      {error && <p className="error">{error}</p>}
    </Section>
  );
}

function ProfileSection({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = displayName.trim();
  const trimmedEmail = email.trim();
  const dirty =
    trimmedName !== (user.display_name ?? "") || trimmedEmail !== (user.email ?? "");
  const canSave = dirty && trimmedName.length > 0 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile({
        display_name: trimmedName,
        email: trimmedEmail, // empty clears the (nullable) email server-side
      });
      onUser(updated);
      setDisplayName(updated.display_name);
      setEmail(updated.email ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="个人资料" note="显示名会展示给团队成员；邮箱用于后续找回密码（可选）。">
      <div className="field">
        <span className="field-label">用户名</span>
        <input value={user.username} disabled />
      </div>
      <div className="field">
        <span className="field-label">显示名</span>
        <input
          value={displayName}
          maxLength={200}
          placeholder="你的显示名"
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="field">
        <span className="field-label">邮箱（可选）</span>
        <input
          type="email"
          value={email}
          maxLength={255}
          placeholder="you@example.com"
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="field-actions">
        <button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </Section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const localError =
    next.length > 0 && next.length < 8
      ? "新密码至少需要 8 个字符"
      : confirm.length > 0 && next !== confirm
        ? "两次输入的新密码不一致"
        : null;
  const canSave = current.length > 0 && next.length >= 8 && next === confirm && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "修改失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="修改密码" note="修改后，除当前设备外的所有登录都会失效。">
      <div className="field">
        <span className="field-label">当前密码</span>
        <input
          type="password"
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="field">
        <span className="field-label">新密码（至少 8 位）</span>
        <input
          type="password"
          value={next}
          autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <div className="field">
        <span className="field-label">确认新密码</span>
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {(localError || error) && <p className="error">{localError ?? error}</p>}
      {done && <p className="section-note" style={{ color: "var(--success)" }}>密码已更新，其他设备需重新登录。</p>}
      <div className="field-actions">
        <button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "更新中…" : "更新密码"}
        </button>
      </div>
    </Section>
  );
}

function DangerSection({ onDeleted }: { onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "注销失败，请重试");
      setBusy(false);
    }
  }

  return (
    <Section
      title="危险区域"
      note="注销后账户将被停用并匿名化，且无法恢复。"
      danger
    >
      {!confirming ? (
        <div className="field-actions">
          <button type="button" className="btn-danger-outline" onClick={() => setConfirming(true)}>
            注销账户
          </button>
        </div>
      ) : (
        <>
          <p className="section-note">输入密码以确认注销，相关对话也会被删除。</p>
          <input
            type="password"
            value={password}
            placeholder="当前密码"
            autoComplete="current-password"
            onChange={(e) => {
              setError(null);
              setPassword(e.target.value);
            }}
          />
          {error && <p className="error">{error}</p>}
          <div className="field-actions">
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                setConfirming(false);
                setPassword("");
                setError(null);
              }}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={busy || password.length === 0}
              onClick={() => void confirm()}
            >
              {busy ? "注销中…" : "确认注销"}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}
