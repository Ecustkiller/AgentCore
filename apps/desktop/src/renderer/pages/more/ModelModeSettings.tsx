import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  MODEL_FLASH,
  ROLE_DESCRIPTIONS,
  TEAM_ROLE_ORDER,
  effectiveRoleModel,
  isRoleLocked,
  modeCostTier,
  modeRefLabel,
  modelLabel,
  modelNote,
  presetLabel,
  roleLabel,
} from "@/lib/modelModes";
import {
  type ModelModeCatalog,
  type ModelModePreset,
  type ModelModeSummary,
  createModelMode,
  deleteModelMode,
  fetchModelModeCatalog,
  setDefaultModelMode,
  updateModelMode,
} from "@/services/modelModes";
import { useAuthStore } from "@/stores/auth";
import { useModelModesStore } from "@/stores/modelModes";
import {
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * 质量档 management (D2, /more/model-modes) — the user configures, in 团队语言,
 * which models their Agent team uses. One unified list doubles as the account-default
 * picker (select a row = set default) and the catalog: built-in presets first, then
 * the user's custom modes (CEO 本体 + 主力 worker configurable; 经济 worker locked
 * to Flash). Each row shows its 角色→模型 mapping + relative cost, expandable to the
 * full team. All bounded by the operator ceiling (catalog.models); the composer's
 * per-conversation picker draws from the same store.
 */
export function ModelModeSettings() {
  const presets = useModelModesStore((s) => s.presets);
  const custom = useModelModesStore((s) => s.custom);
  const defaultMode = useModelModesStore((s) => s.defaultMode);
  const loading = useModelModesStore((s) => s.loading);
  const loaded = useModelModesStore((s) => s.loaded);
  const error = useModelModesStore((s) => s.error);
  const refresh = useModelModesStore((s) => s.refresh);

  const user = useAuthStore((s) => s.user);
  const defaultRef = user?.defaultModelMode ?? null;

  const [catalog, setCatalog] = useState<ModelModeCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  // The custom mode being created (no id) or edited (with id); null = form closed.
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    assignments: Record<string, string>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);

  const loadCatalog = useCallback(() => {
    setCatalogError(false);
    return fetchModelModeCatalog()
      .then(setCatalog)
      .catch(() => {
        setCatalog(null);
        setCatalogError(true);
      });
  }, []);

  useEffect(() => {
    void refresh();
    void loadCatalog();
  }, [refresh, loadCatalog]);

  // Set (or clear with null = 跟随系统默认) the account default; optimistic on the
  // auth store so the radio updates instantly, then persisted.
  const setDefault = async (ref: string | null) => {
    if (settingDefault || (user?.defaultModelMode ?? null) === ref) return;
    setSettingDefault(true);
    try {
      await setDefaultModelMode(ref);
      const u = useAuthStore.getState().user;
      if (u) {
        useAuthStore
          .getState()
          .setAuthenticated({ ...u, defaultModelMode: ref });
      }
      await refresh();
    } catch {
      /* 设置失败保持原值 */
    } finally {
      setSettingDefault(false);
    }
  };

  const startCreate = () => {
    setFormError(null);
    setEditing({ name: "", assignments: {} });
  };
  const startEdit = (m: ModelModeSummary) => {
    setFormError(null);
    setEditing({ id: m.id, name: m.name, assignments: { ...m.assignments } });
  };

  const save = async (name: string, assignments: Record<string, string>) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing?.id) {
        await updateModelMode(editing.id, { name, assignments });
      } else {
        await createModelMode(name, assignments);
      }
      setEditing(null);
      await refresh();
    } catch {
      setFormError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  // Deleting the档 that is the current account default would leave a dangling ref,
  // so first revert the default to 跟随系统默认, then delete.
  const remove = async (m: ModelModeSummary) => {
    try {
      if ((user?.defaultModelMode ?? null) === m.id) {
        await setDefault(null);
      }
      await deleteModelMode(m.id);
      await refresh();
    } catch {
      /* 删除失败保持原状，用户可重试 */
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold">质量档</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        为你的 Agent 团队选择模型：经济档全程使用经济模型最省成本；高质量档让
        CEO 本体与主力 worker
        用更强的模型。选中某档即设为账号默认，也可新建自定义档按团队角色分别指定。
      </p>

      {error && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs text-warning">
          {error}
        </div>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-medium">账号默认档位</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              新对话从这里开始；每个对话仍可在输入框单独切换。
            </p>
          </div>
          <SimpleTooltip
            label={catalog ? "新建自定义档" : "模型选项加载中或加载失败"}
          >
            <span className="inline-flex shrink-0">
              <button
                type="button"
                onClick={startCreate}
                disabled={!catalog || !!editing}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <Plus size={16} />
                新建
              </button>
            </span>
          </SimpleTooltip>
        </div>

        <div className="mt-4 space-y-2">
          {loading && !loaded ? (
            <SkeletonRows />
          ) : (
            <>
              <InheritRow
                selected={defaultRef === null}
                resolvedRef={defaultMode}
                custom={custom}
                busy={settingDefault}
                onSelect={() => void setDefault(null)}
              />

              <ListLabel>系统预设</ListLabel>
              {presets.map((p: ModelModePreset) => (
                <ModeRow
                  key={p.key}
                  name={presetLabel(p.key)}
                  assignments={p.assignments}
                  kind="preset"
                  selected={defaultRef === p.key}
                  busy={settingDefault}
                  onSetDefault={() => void setDefault(p.key)}
                />
              ))}

              <ListLabel>我的质量档</ListLabel>
              {custom.length === 0 && !editing ? (
                <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                  还没有自定义档；点「新建」按团队角色分别指定模型。
                </p>
              ) : (
                custom.map((m) => (
                  <ModeRow
                    key={m.id}
                    name={m.name}
                    assignments={m.assignments}
                    kind="custom"
                    selected={defaultRef === m.id}
                    busy={settingDefault}
                    onSetDefault={() => void setDefault(m.id)}
                    onEdit={() => startEdit(m)}
                    onDelete={() => void remove(m)}
                  />
                ))
              )}

              {catalogError && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs text-warning">
                  <span>模型选项加载失败，暂时无法新建或编辑自定义档。</span>
                  <button
                    type="button"
                    onClick={() => void loadCatalog()}
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-warning/40 px-2 text-warning hover:bg-warning/10"
                  >
                    <RotateCw size={13} />
                    重试
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {editing && catalog && (
          <ModeForm
            catalog={catalog}
            initialName={editing.name}
            initialAssignments={editing.assignments}
            saving={saving}
            error={formError}
            isEdit={!!editing.id}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        )}
      </section>
    </div>
  );
}

/** A thin group label inside the unified档 list. */
function ListLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

/** Loading placeholders for the档 list. */
function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[58px] animate-pulse rounded-xl border border-border bg-card"
        />
      ))}
    </>
  );
}

/** The "set as account default" radio control (filled = current default). */
function RadioDot({
  selected,
  disabled,
  onClick,
  title,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <SimpleTooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={selected}
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50 ${
          selected ? "border-primary" : "border-input hover:border-primary/60"
        }`}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </button>
    </SimpleTooltip>
  );
}

/** The "默认" pill marking the currently-selected (account-default)档. */
function DefaultPill() {
  return (
    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
      默认
    </span>
  );
}

/** A relative-cost pill derived from a mode's assignments. */
function CostBadge({ assignments }: { assignments: Record<string, string> }) {
  const tier = modeCostTier(assignments);
  const tone =
    tier.level === "base"
      ? "bg-muted text-muted-foreground"
      : tier.level === "mid"
        ? "bg-info/10 text-info"
        : "bg-warning/10 text-warning";
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${tone}`}>
      {tier.label}
    </span>
  );
}

/** The 跟随系统默认 (inherit) row — defers to the operator default, shown resolved. */
function InheritRow({
  selected,
  resolvedRef,
  custom,
  busy,
  onSelect,
}: {
  selected: boolean;
  resolvedRef: string;
  custom: ModelModeSummary[];
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <RadioDot
          selected={selected}
          disabled={busy}
          onClick={onSelect}
          title={selected ? "当前账号默认" : "设为账号默认"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm text-foreground">
              跟随系统默认
            </span>
            {selected && <DefaultPill />}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            当前解析为「{modeRefLabel(resolvedRef, custom)}」
          </p>
        </div>
      </div>
    </div>
  );
}

/** One档 row (preset or custom): radio-as-default + summary + cost, expandable to
 *  the full team; custom rows add edit / inline-confirm delete. */
function ModeRow({
  name,
  assignments,
  kind,
  selected,
  busy,
  onSetDefault,
  onEdit,
  onDelete,
}: {
  name: string;
  assignments: Record<string, string>;
  kind: "preset" | "custom";
  selected: boolean;
  busy: boolean;
  onSetDefault: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <RadioDot
          selected={selected}
          disabled={busy}
          onClick={onSetDefault}
          title={selected ? "当前账号默认" : "设为账号默认"}
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{name}</span>
              {kind === "preset" && (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  系统
                </span>
              )}
              {selected && <DefaultPill />}
              <CostBadge assignments={assignments} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <AssignmentSummary assignments={assignments} />
            </p>
          </div>
          <ChevronDown
            size={14}
            className={`shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>

        {kind === "custom" && !confirming && (
          <div className="flex shrink-0 items-center gap-1">
            <SimpleTooltip label="编辑">
              <button
                type="button"
                onClick={onEdit}
                aria-label="编辑"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Pencil size={14} />
              </button>
            </SimpleTooltip>
            <SimpleTooltip label="删除">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label="删除"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </SimpleTooltip>
          </div>
        )}
        {kind === "custom" && confirming && (
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-xs text-muted-foreground">删除？</span>
            <SimpleTooltip label="取消">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                aria-label="取消"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X size={14} />
              </button>
            </SimpleTooltip>
            <SimpleTooltip label="确认删除">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onDelete?.();
                }}
                aria-label="确认删除"
                className="flex size-8 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
              >
                <Check size={14} />
              </button>
            </SimpleTooltip>
          </div>
        )}
      </div>

      {expanded && <TeamDetail assignments={assignments} />}
    </div>
  );
}

/** The full team picture for a mode: every role's effective model (incl. locked). */
function TeamDetail({ assignments }: { assignments: Record<string, string> }) {
  return (
    <div className="mt-2.5 space-y-1.5 border-t border-border pl-[26px] pt-2.5">
      {TEAM_ROLE_ORDER.map((role) => {
        const model = effectiveRoleModel(role, assignments);
        return (
          <div
            key={role}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="text-muted-foreground">
              {roleLabel(role)}
              {isRoleLocked(role) && (
                <span className="ml-1 opacity-70">（锁定）</span>
              )}
            </span>
            <span className="text-foreground">
              {modelLabel(model)}
              {modelNote(model) && (
                <span className="ml-1 text-muted-foreground">
                  · {modelNote(model)}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A one-line "角色 → 模型" summary for a mode's assignments (empty = all base). */
function AssignmentSummary({
  assignments,
}: {
  assignments: Record<string, string>;
}) {
  const entries = Object.entries(assignments);
  if (entries.length === 0) return <>全程经济模型</>;
  return (
    <>
      {entries
        .map(([role, model]) => `${roleLabel(role)} → ${modelLabel(model)}`)
        .join("，")}
    </>
  );
}

/** Create / edit form for a custom mode — name + a model per configurable role. */
function ModeForm({
  catalog,
  initialName,
  initialAssignments,
  saving,
  error,
  isEdit,
  onCancel,
  onSave,
}: {
  catalog: ModelModeCatalog;
  initialName: string;
  initialAssignments: Record<string, string>;
  saving: boolean;
  error: string | null;
  isEdit: boolean;
  onCancel: () => void;
  onSave: (name: string, assignments: Record<string, string>) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [assignments, setAssignments] =
    useState<Record<string, string>>(initialAssignments);

  const setRole = (role: string, model: string) =>
    setAssignments((prev) => {
      const next = { ...prev };
      if (model) next[role] = model;
      else delete next[role];
      return next;
    });

  const canSave = name.trim().length > 0 && !saving;

  return (
    <div className="mt-3 rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium text-foreground">
        {isEdit ? "编辑质量档" : "新建质量档"}
      </p>

      <label className="mt-3 block">
        <span className="text-xs text-muted-foreground">名称</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：深度研究档"
          maxLength={100}
          className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </label>

      <div className="mt-4 space-y-3">
        {catalog.roles.map((r) =>
          r.configurable ? (
            <div
              key={r.role}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">{roleLabel(r.role)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {ROLE_DESCRIPTIONS[r.role]}
                </p>
              </div>
              <select
                value={assignments[r.role] ?? ""}
                onChange={(e) => setRole(r.role, e.target.value)}
                className="h-8 shrink-0 rounded-lg border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">默认（经济）</option>
                {catalog.models.map((m) => (
                  <option key={m} value={m}>
                    {modelLabel(m)}
                    {modelNote(m) ? ` · ${modelNote(m)}` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div
              key={r.role}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">{roleLabel(r.role)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {ROLE_DESCRIPTIONS[r.role]}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                锁定：{modelLabel(r.locked_model ?? MODEL_FLASH)}
              </span>
            </div>
          ),
        )}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void onSave(name.trim(), assignments)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          保存
        </button>
      </div>
    </div>
  );
}
