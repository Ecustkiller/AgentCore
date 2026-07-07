import {
  type LlmKeyStatus,
  clearLlmKey,
  getLlmKey,
  setLlmKey,
  testLlmKey,
} from "@/api/model";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "@/pages/more/more.css";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o";

function capabilityLabel(supportsTools: boolean | null | undefined): string {
  if (supportsTools === true) return "支持工具调用";
  if (supportsTools === false) return "仅对话";
  return "未测试能力";
}

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
        setEditing(!s.configured);
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
        <button
          type="button"
          className="link"
          onClick={() => navigate("/more")}
        >
          ← 设置
        </button>
        <span>模型配置</span>
        <span style={{ width: 44 }} />
      </header>

      <div className="settings-body">
        <p className="settings-desc">
          配置 OpenAI 兼容端点（API Key、Base URL、默认模型名）。Key 经 AES
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
                initialBaseUrl={status?.base_url ?? ""}
                initialModel={status?.default_model ?? ""}
                onSaved={(s) => {
                  setStatus(s);
                  setEditing(false);
                }}
                onCancel={
                  status?.configured ? () => setEditing(false) : undefined
                }
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
      <span className="status-line status-err">
        ● {status.message ?? "连接失败"}
      </span>
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
      onChanged({
        configured: false,
        status: "unconfigured",
        masked_key: null,
        message: null,
        billing_mode: status.billing_mode,
        billing_preference: status.billing_preference,
        platform_available: status.platform_available,
      });
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
        {status.base_url && (
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            {status.base_url}
          </p>
        )}
        {status.default_model && (
          <p style={{ marginTop: 4, fontSize: 12 }}>
            模型 {status.default_model}
          </p>
        )}
        <div style={{ marginTop: 6 }}>
          <StatusBadge status={status} />
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {capabilityLabel(status.supports_tools)}
          </span>
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
    </div>
  );
}

function KeyForm({
  configured,
  initialBaseUrl,
  initialModel,
  onSaved,
  onCancel,
}: {
  configured: boolean;
  initialBaseUrl: string;
  initialModel: string;
  onSaved: (s: LlmKeyStatus) => void;
  onCancel?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [defaultModel, setDefaultModel] = useState(initialModel);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = apiKey.trim().length > 0 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await setLlmKey({
          api_key: apiKey.trim(),
          base_url: baseUrl.trim() || null,
          default_model: defaultModel.trim() || null,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section-card">
      <span className="section-title">
        {configured ? "更换模型配置" : "填写模型配置"}
      </span>
      <label className="field-label" htmlFor="llm-api-key">
        API Key
      </label>
      <div className="key-input-wrap">
        <input
          id="llm-api-key"
          type={reveal ? "text" : "password"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="key-reveal"
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? "隐藏" : "显示"}
        </button>
      </div>
      <label
        className="field-label"
        htmlFor="llm-base-url"
        style={{ marginTop: 12 }}
      >
        Base URL
      </label>
      <input
        id="llm-base-url"
        type="text"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={DEFAULT_BASE_URL}
        autoComplete="off"
        spellCheck={false}
        className="text-input"
      />
      <label
        className="field-label"
        htmlFor="llm-default-model"
        style={{ marginTop: 12 }}
      >
        默认模型名
      </label>
      <input
        id="llm-default-model"
        type="text"
        value={defaultModel}
        onChange={(e) => setDefaultModel(e.target.value)}
        placeholder={DEFAULT_MODEL}
        autoComplete="off"
        spellCheck={false}
        className="text-input"
      />
      <div className="field-actions">
        {onCancel && (
          <button
            type="button"
            className="btn-outline"
            onClick={onCancel}
            disabled={saving}
          >
            取消
          </button>
        )}
        <button type="button" disabled={!canSave} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function InfoNote() {
  return (
    <p className="section-note" style={{ marginTop: 16 }}>
      你的 Key 仅用于你自己的对话，经 AES-256-GCM 加密存储，服务端只显示后 4
      位。全链路使用同一模型；平台只统计 token 用量。
    </p>
  );
}
