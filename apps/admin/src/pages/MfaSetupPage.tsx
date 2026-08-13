import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { ApiError, clearCsrfToken, errorMessage } from "@/services/api";
import { logout, mfaConfirm, mfaSetup } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? (e.serverMessage ?? fallback) : fallback;
}

type Phase = "setup" | "recovery";

/** Full-screen MFA enrollment wizard for admin accounts. */
export function MfaSetupPage() {
  const setUnauthenticated = useAuthStore((s) => s.setUnauthenticated);

  const [phase, setPhase] = useState<Phase>("setup");
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await mfaSetup();
        if (!cancelled) setSecret(payload.secret);
      } catch (err) {
        if (!cancelled) setError(errMsg(err, errorMessage(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const handleCopySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedSecret(true);
      toast.success("密钥已复制");
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  const handleCopyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopiedCodes(true);
      toast.success("恢复码已复制");
      setTimeout(() => setCopiedCodes(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length < 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await mfaConfirm(code.trim());
      setRecoveryCodes(result.recovery_codes);
      setPhase("recovery");
    } catch (err) {
      setError(errMsg(err, errorMessage(err)));
      setSubmitting(false);
    }
  };

  const handleSignOut = () => {
    void logout().finally(() => setUnauthenticated());
  };

  // `/mfa/confirm` deliberately revokes every session and clears the auth cookies
  // (a password-only session must not inherit admin rights it never proved), so the
  // only honest next step is a fresh login — not "进入管理后台".
  const handleFinish = () => {
    clearCsrfToken();
    setUnauthenticated();
    toast.success("双因素认证已启用，请用新的验证码重新登录");
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (phase === "recovery") {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl bg-success/10 text-success">
              <ShieldCheck size={24} />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">保存恢复码</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                请妥善保存以下恢复码。若丢失身份验证器，可在登录页改用恢复码登录。每个恢复码仅可使用一次。
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-warning">
            恢复码只会显示这一次，关闭后无法再次查看。请复制或抄写后存放在安全位置。
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            启用双因素认证会登出全部设备（含当前这台）。保存好恢复码后，请用密码 +
            验证器中的新验证码重新登录。
          </p>

          <ul className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-border bg-card p-4 font-mono text-sm">
            {recoveryCodes.map((rc) => (
              <li key={rc} className="text-foreground">
                {rc}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-col gap-2">
            <Button variant="outline" onClick={() => void handleCopyCodes()}>
              {copiedCodes ? <Check size={14} /> : <Copy size={14} />}
              {copiedCodes ? "已复制" : "复制全部恢复码"}
            </Button>
            <Button onClick={handleFinish} className="w-full">
              我已保存，重新登录
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">设置双因素认证</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              在身份验证器应用（如 Google Authenticator、Microsoft
              Authenticator）中手动添加下面的密钥
            </p>
          </div>
        </div>

        {error && !secret ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                重试
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                退出登录
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">手动输入密钥</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-sm text-foreground">
                  {secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopySecret()}
                  aria-label="复制密钥"
                >
                  {copiedSecret ? <Check size={14} /> : <Copy size={14} />}
                </Button>
              </div>
            </div>

            <form
              onSubmit={(e) => void handleConfirm(e)}
              className="mt-6 flex flex-col gap-3"
            >
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="输入验证器中的 6 位验证码"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 8))
                }
                disabled={submitting}
                autoFocus
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting || code.length < 6} className="w-full">
                {submitting && <Spinner />}
                {submitting ? "验证中…" : "确认并启用"}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
