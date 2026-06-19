// 模型配置 (/more/model) — BYOK DeepSeek API key (mirrors desktop ModelSettings).
//
// Without a key, turns can't run (backend billing_mode "byok"), so this is the most
// load-bearing settings page on mobile. The key is AES-encrypted at rest; the server
// only ever echoes the last 4 chars. The desktop's 本地引擎 toggle is omitted — sidecar
// is a desktop-only capability (减法 boundary).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setLlmKey,
  testLlmKey,
} from "@/api/model";
import "@/pages/more/more.css";

export function ModelSettings() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<LlmKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    getLlmKey()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setEditing(!s.configured); // unconfigured → open the input straight away
      })
      .catch(() => alive && setLoadError("加载失败，请重试"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="link" onClick={() => navigate("/more")}>
          ← 设置
        </button>
        <span>模型配置</span>
        <span style={{ width: 44 }} />
      </header>

      <div className="settings-body">
        <p className="settings-desc">
          填入你自己的 DeepSeek API Key，对话将使用你的额度运行。Key 经 AES
          加密存储，仅回显后 4 位；未配置则无法发起对话。
        </p>

        {loading ? (
          <p className="muted hint">加载中…</p>
        ) : loadError ? (
          <p className="error hint">{loadError}</p>
        ) : (
          <>
            {status?.configured && !editing && (
              <ConfiguredCard
                status={status}
                onChanged={setStatus}
                onReplace={() => setEditing(true)}
              />
            )}
            {editing && (
              <KeyForm
                configured={!!status?.configured}
                onSaved={(s) => {
                  setStatus(s);
                  setEditing(false);
                }}
                onCancel={status?.configured ? () => setEditing(false) : undefined}
              />
            )}
            <InfoNote />
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: LlmKeyStatus }) {
  if (status.status === "active") {
    return <span className="status-line status-ok">● 连接正常</span>;
  }
  if (status.status === "error") {
    return (
      <span className="status-line status-err">● {status.message ?? "连接失败"}</span>
    );
  }
  return <span className="status-line status-idle">未测试</span>;
}

function ConfiguredCard({
  status,
  onChanged,
  onReplace,
}: {
  status: LlmKeyStatus;
  onChanged: (s: LlmKeyStatus) => void;
  onReplace: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function test() {
    setTesting(true);
    setError(null);
    try {
      onChanged(await testLlmKey());
    } catch (e) {
      setError(e instanceof Error ? e.message : "测试失败，请重试");
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      await clearLlmKey();
      onChanged({ configured: false, status: "unconfigured", masked_key: null, message: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败，请重试");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="section-card">
      <div>
        <span className="masked-key">{status.masked_key ?? "已配置"}</span>
        <div style={{ marginTop: 6 }}>
          <StatusBadge status={status} />
        </div>
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn-outline"
          onClick={() => void test()}
          disabled={testing || removing}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button
          type="button"
          className="btn-outline"
          onClick={onReplace}
          disabled={testing || removing}
        >
          更换
        </button>
        <button
          type="button"
          className="btn-danger-outline"
          onClick={() => void remove()}
          disabled={testing || removing}
        >
          {removing ? "删除中…" : "删除"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <a
        className="ext-link"
        href="https://platform.deepseek.com/usage"
        target="_blank"
        rel="noreferrer"
      >
        查看用量/余额 ↗
      </a>
    </div>
  );
}

function KeyForm({
  configured,
  onSaved,
  onCancel,
}: {
  configured: boolean;
  onSaved: (s: LlmKeyStatus) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = value.trim().length > 0 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await setLlmKey(value.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section-card">
      <span className="section-title">
        {configured ? "更换 API Key" : "填写 DeepSeek API Key"}
      </span>
      <div className="key-input-wrap">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="key-reveal" onClick={() => setReveal((r) => !r)}>
          {reveal ? "隐藏" : "显示"}
        </button>
      </div>
      <div className="field-actions">
        {onCancel && (
          <button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>
            取消
          </button>
        )}
        <button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <a
        className="ext-link"
        href="https://platform.deepseek.com/api_keys"
        target="_blank"
        rel="noreferrer"
      >
        前往 DeepSeek 开放平台创建 API Key ↗
      </a>
    </div>
  );
}

function InfoNote() {
  return (
    <p className="section-note" style={{ marginTop: 16 }}>
      你的 Key 仅用于你自己的对话，经 AES-256-GCM 加密存储，服务端只显示后 4
      位、不会回传完整内容。对话与后台任务（标题、记忆）都按你的 DeepSeek 额度计费。
    </p>
  );
}
