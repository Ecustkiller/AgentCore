import { getTokens } from "@/api/client";
import {
  type DocumentApplyMode,
  type DocumentNode,
  createRuleDocument,
  deleteDocument,
  getDocument,
  isDocumentsUnavailable,
  listUserRules,
  renameDocument,
  updateDocumentApplyMode,
  writeDocument,
} from "@/api/documents";
// 用户规则 (/rules) — mobile lens on user-owned rule documents (Agent记忆与知识系统
// §5.2 / §5.4). Reached from the 文件 tab beside「全局设定」. GLOBAL scope only
// (per-project rules stay desktop). List / create / edit / delete + 常驻·按需.
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "@/pages/more/more.css";

const APPLY_LABEL: Record<DocumentApplyMode, string> = {
  always: "常驻",
  on_demand: "按需",
};

const APPLY_HINT: Record<DocumentApplyMode, string> = {
  always: "短硬约束",
  on_demand: "长条文或偶发",
};

/** Ensure a rule doc name is markdown so it opens as editable text. */
function ensureMdName(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

/** Collision-free "新规则.md" (then "新规则 2.md", …). */
function nextRuleName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = "新规则";
  if (!taken.has(`${base}.md`)) return `${base}.md`;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function RulesPage() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<DocumentNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onAuthError = useCallback(
    (e: unknown) => {
      if (!getTokens()) navigate("/login", { replace: true });
      return e;
    },
    [navigate],
  );

  const load = useCallback(() => {
    setError(null);
    setUnavailable(false);
    listUserRules()
      .then((rows) => setRules(rows))
      .catch((e) => {
        onAuthError(e);
        if (isDocumentsUnavailable(e)) {
          setUnavailable(true);
          setRules([]);
        } else {
          setError("加载失败");
          setRules([]);
        }
      });
  }, [onAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  async function createRule() {
    if (creating) return;
    setCreating(true);
    setStatus(null);
    setError(null);
    try {
      const name = nextRuleName((rules ?? []).map((r) => r.name));
      const doc = await createRuleDocument(name);
      setRules((prev) =>
        [...(prev ?? []).filter((r) => r.id !== doc.id), doc].sort((a, b) =>
          a.name.localeCompare(b.name, "zh"),
        ),
      );
      setStatus("已新建规则（默认常驻）");
    } catch (e) {
      onAuthError(e);
      setError("新建规则失败，请重试");
    } finally {
      setCreating(false);
    }
  }

  function patchRule(id: string, next: DocumentNode) {
    setRules((prev) =>
      (prev ?? [])
        .map((r) => (r.id === id ? next : r))
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    );
  }

  function removeFromList(id: string) {
    setRules((prev) => (prev ?? []).filter((r) => r.id !== id));
  }

  return (
    <div className="screen">
      <header className="bar">
        <button
          type="button"
          className="link icon-btn"
          aria-label="返回"
          onClick={() => navigate("/files")}
        >
          <ChevronLeft size={20} />
        </button>
        <span className="bar-title">规则</span>
        <span className="bar-right" aria-hidden />
      </header>

      <div className="settings-body">
        <p className="settings-desc">
          你写下的规则会指导 AI 如何做事。短硬约束用常驻，长条文或偶发用按需。
        </p>

        <section className="section">
          <div className="rule-section-head">
            <h2 className="section-title">你的规则</h2>
            <button
              type="button"
              className="btn-outline"
              disabled={creating || unavailable}
              onClick={() => void createRule()}
            >
              {creating ? "新建中…" : "新建规则"}
            </button>
          </div>
          <p className="section-note">
            全局生效。点击「常驻 / 按需」可切换；点开规则可编辑正文。
          </p>
          <div className="section-card">
            {rules === null ? (
              <p className="section-note">加载中…</p>
            ) : unavailable ? (
              <p className="section-note">规则功能暂不可用（服务端待升级）</p>
            ) : error && rules.length === 0 ? (
              <>
                <p className="error">{error}</p>
                <button type="button" className="btn-outline" onClick={load}>
                  重试
                </button>
              </>
            ) : rules.length === 0 ? (
              <div className="file-empty" style={{ padding: "20px 8px" }}>
                <p className="file-empty-title">还没有全局规则</p>
                <p className="muted hint">短硬约束用常驻，长条文或偶发用按需</p>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={creating}
                  onClick={() => void createRule()}
                >
                  新建规则
                </button>
              </div>
            ) : (
              rules.map((doc) => (
                <RuleItem
                  key={doc.id}
                  doc={doc}
                  onPatched={(next) => patchRule(doc.id, next)}
                  onDeleted={() => removeFromList(doc.id)}
                  onStatus={setStatus}
                  onAuthError={onAuthError}
                />
              ))
            )}
            {status && <p className="section-note">{status}</p>}
            {error && rules !== null && rules.length > 0 && (
              <p className="error">{error}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** One rule — row with apply-mode chip; expands to CAS editor + rename/delete. */
function RuleItem({
  doc,
  onPatched,
  onDeleted,
  onStatus,
  onAuthError,
}: {
  doc: DocumentNode;
  onPatched: (next: DocumentNode) => void;
  onDeleted: () => void;
  onStatus: (msg: string | null) => void;
  onAuthError: (e: unknown) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = doc.applyMode;
  const other: DocumentApplyMode = mode === "always" ? "on_demand" : "always";

  async function expand() {
    const next = !open;
    setOpen(next);
    if (!next || loaded) return;
    setError(null);
    try {
      const d = await getDocument(doc.id);
      setContent(d.content);
      setSaved(d.content);
      setVersion(d.version);
      setLoaded(true);
      if (d.applyMode !== doc.applyMode || d.name !== doc.name) {
        onPatched({ ...doc, applyMode: d.applyMode, name: d.name });
      }
    } catch (e) {
      onAuthError(e);
      setError("加载失败");
    }
  }

  async function toggleApplyMode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    onStatus(null);
    try {
      const next = await updateDocumentApplyMode(doc.id, other);
      onPatched(next);
      onStatus(`已设为${APPLY_LABEL[other]}`);
    } catch (e) {
      onAuthError(e);
      setError("切换失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await writeDocument(doc.id, content, version);
      if (r.conflict) {
        const live = await getDocument(doc.id);
        setContent(live.content);
        setSaved(live.content);
        setVersion(live.version);
        setError("内容已在别处更新，已为你刷新，请重新编辑后保存。");
        return;
      }
      setSaved(content);
      setVersion(r.version);
      onStatus("已保存");
    } catch (e) {
      onAuthError(e);
      setError("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const input = window.prompt("规则名称", doc.name);
    if (input === null) return;
    const name = ensureMdName(input.trim());
    if (name === ".md" || name === doc.name) return;
    setBusy(true);
    setError(null);
    try {
      const next = await renameDocument(doc.id, name);
      onPatched(next);
      onStatus("已重命名");
    } catch (e) {
      onAuthError(e);
      setError("重命名失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`确定删除规则「${doc.name}」？此操作不可撤销。`))
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await deleteDocument(doc.id);
      if (!r.ok) throw new Error("删除冲突");
      onDeleted();
      onStatus("已删除规则");
    } catch (e) {
      onAuthError(e);
      setError("删除失败，请重试");
      setBusy(false);
    }
  }

  const dirty = loaded && content !== saved;

  return (
    <div className="mem-topic">
      <div className="rule-row">
        <button
          type="button"
          className="mem-topic-head rule-row-main"
          aria-expanded={open}
          onClick={() => void expand()}
        >
          <span className="mem-topic-name">{doc.name}</span>
          <span className="mem-topic-chevron" aria-hidden>
            {open ? "▾" : "›"}
          </span>
        </button>
        <button
          type="button"
          className="rule-apply-chip"
          title={`${APPLY_LABEL[mode]} · ${APPLY_HINT[mode]}（点击切换）`}
          aria-label={`应用方式：${APPLY_LABEL[mode]}，点击切换`}
          disabled={busy}
          onClick={() => void toggleApplyMode()}
        >
          {APPLY_LABEL[mode]}
        </button>
      </div>
      {open && (
        <div className="mem-topic-body">
          {!loaded && !error ? (
            <p className="section-note">加载中…</p>
          ) : (
            <>
              <p className="section-note">
                {APPLY_LABEL[mode]} · {APPLY_HINT[mode]}
              </p>
              <textarea
                className="mem-textarea"
                value={content}
                rows={6}
                onChange={(e) => setContent(e.target.value)}
              />
              {error && <p className="error">{error}</p>}
              <div className="field-actions">
                <button
                  type="button"
                  className="btn-outline"
                  disabled={busy}
                  onClick={() => void rename()}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="btn-danger-outline"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  删除
                </button>
                <button
                  type="button"
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                >
                  {busy ? "处理中…" : "保存"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {!open && error && <p className="error">{error}</p>}
    </div>
  );
}
