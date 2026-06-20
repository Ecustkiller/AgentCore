import { login } from "@/api/auth";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen center">
      <form className="card" onSubmit={onSubmit}>
        <h1>AgentCore 手机端</h1>
        <p className="muted">骨架 · bearer 登录</p>
        <input
          placeholder="用户名"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          placeholder="密码"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
