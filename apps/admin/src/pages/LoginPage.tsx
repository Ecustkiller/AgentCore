import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { errorMessage } from "@/services/api";
import { login } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

export function LoginPage() {
  const setAuthenticated = useAuthStore((s) => s.setAuthenticated);
  const setForbidden = useAuthStore((s) => s.setForbidden);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    try {
      const user = await login(username, password);
      // Admin-only console: a valid non-admin session lands on the 权限 wall.
      if (user.role === "admin") setAuthenticated(user);
      else setForbidden(user);
    } catch (err) {
      toast.error(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              AgentCore 管理后台
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              仅限平台管理员登录
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="text"
            autoComplete="username"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            // biome-ignore lint/a11y/noAutofocus: single-purpose login form
            autoFocus
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
          <Button
            type="submit"
            disabled={submitting || !username || !password}
            className="mt-1 w-full"
          >
            {submitting && <Spinner />}
            {submitting ? "登录中…" : "登录"}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          忘记密码？请联系其他平台管理员在用户管理中重置，或联系运维。
        </p>
      </div>
    </div>
  );
}
