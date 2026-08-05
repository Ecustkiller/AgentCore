import {
  type AutonomyRecipe,
  COMMAND_OPTIONS,
  FILE_WRITE_OPTIONS,
  HOST_OPTIONS,
  type PermissionAxes,
  RECIPE_LABELS,
  RECIPE_ORDER,
  TEAM_KICKOFF_OPTIONS,
  axesEqual,
  axesShortLabel,
  confirmAutoCommandIfNeeded,
  isIllegalAxes,
  matchRecipe,
  recipeToAxes,
  setConversationPermissionAxes,
  setUserDefaultRecipe,
} from "@/api/permissionAxes";
import { Modal } from "@/components/Modal";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

/**
 * 本会话权限四轴 sheet — 配方优先，自定义四轴折叠；可「设为新会话默认」（仅内置配方）。
 */
export function PermissionAxesSheet({
  conversationId,
  axes,
  disabled,
  onAxesChange,
  onClose,
  onError,
}: {
  /** null = 草稿（尚未建会话）；改动只回写本地。 */
  conversationId: string | null;
  axes: PermissionAxes;
  disabled?: boolean;
  onAxesChange: (next: PermissionAxes) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(
    () => matchRecipe(axes) === "custom",
  );
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const recipe = matchRecipe(axes);
  const isCustom = recipe === "custom";
  const label = axesShortLabel(axes);

  const apply = async (next: PermissionAxes) => {
    if (pending || disabled) return;
    if (isIllegalAxes(next)) return;
    if (axesEqual(next, axes)) return;
    if (!confirmAutoCommandIfNeeded(axes, next)) return;

    if (!conversationId) {
      onAxesChange(next);
      setHint(`已切换为「${axesShortLabel(next)}」`);
      return;
    }

    setPending(true);
    setHint(null);
    try {
      const saved = await setConversationPermissionAxes(conversationId, next);
      onAxesChange(saved);
      setHint(`已切换为「${axesShortLabel(saved)}」`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "切换权限失败";
      onError?.(msg);
      setHint(msg);
    } finally {
      setPending(false);
    }
  };

  const applyRecipe = (id: AutonomyRecipe) => {
    setCustomOpen(false);
    void apply(recipeToAxes(id));
  };

  const setAsSessionDefault = async () => {
    if (recipe === "custom" || pending || disabled) return;
    setPending(true);
    setHint(null);
    try {
      const saved = await setUserDefaultRecipe(recipe);
      setHint(`新会话将默认「${RECIPE_LABELS[saved].short}」`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "设置默认失败";
      onError?.(msg);
      setHint(msg);
    } finally {
      setPending(false);
    }
  };

  const patchAxis = <K extends keyof PermissionAxes>(
    key: K,
    value: PermissionAxes[K],
  ) => {
    const next = { ...axes, [key]: value };
    if (key === "command" && value === "auto" && next.file_write === "ask") {
      next.file_write = "session";
    }
    if (key === "file_write" && value === "ask" && next.command === "auto") {
      return;
    }
    void apply(next);
  };

  return (
    <Modal
      className="sheet permission-sheet"
      onClose={onClose}
      label={`权限：${label}`}
    >
      <div className="sheet-title">本会话权限 · {label}</div>

      <p className="permission-section-label">配方</p>
      <div className="permission-recipe-list" aria-label="权限配方">
        {RECIPE_ORDER.map((id) => {
          const selected = recipe === id;
          const meta = RECIPE_LABELS[id];
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              disabled={disabled || pending}
              className={
                selected ? "permission-recipe selected" : "permission-recipe"
              }
              onClick={() => applyRecipe(id)}
            >
              <span className="permission-recipe-name">
                {meta.short}
                {id === "less_interrupt" ? " · 荐" : ""}
              </span>
              <span className="permission-recipe-desc muted">
                {meta.description}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="more-row"
        disabled={isCustom || pending || disabled}
        data-testid="permission-set-default"
        onClick={() => void setAsSessionDefault()}
      >
        <div className="more-row-main">
          <span className="more-row-title">设为新会话默认</span>
          <span className="more-row-sub muted">
            {isCustom
              ? "仅内置配方可设为新会话默认"
              : "写入账户默认；只影响之后新建的对话"}
          </span>
        </div>
      </button>

      <button
        type="button"
        className="more-row"
        aria-expanded={customOpen}
        data-testid="permission-custom-toggle"
        onClick={() => setCustomOpen((v) => !v)}
      >
        <div className="more-row-main">
          <span className="more-row-title">
            自定义权限轴
            {isCustom ? <span className="muted"> · 当前</span> : null}
          </span>
        </div>
        <ChevronDown
          size={16}
          className={`muted${customOpen ? " permission-chevron-open" : ""}`}
          aria-hidden
        />
      </button>

      {customOpen && (
        <div className="permission-axes" data-testid="permission-custom-axes">
          <AxisSegment
            title="改文件"
            options={FILE_WRITE_OPTIONS}
            value={axes.file_write}
            disabled={disabled || pending}
            disabledOption={(v) => v === "ask" && axes.command === "auto"}
            disabledReason="免审执行须同时「本会话信任」改文件"
            onSelect={(v) => patchAxis("file_write", v)}
          />
          <AxisSegment
            title="执行命令"
            options={COMMAND_OPTIONS}
            value={axes.command}
            disabled={disabled || pending}
            disabledOption={(v) => v === "auto" && axes.file_write === "ask"}
            disabledReason="免审执行须同时「本会话信任」改文件"
            onSelect={(v) => patchAxis("command", v)}
          />
          <AxisSegment
            title="组队确认"
            options={TEAM_KICKOFF_OPTIONS}
            value={axes.team_kickoff}
            disabled={disabled || pending}
            onSelect={(v) => patchAxis("team_kickoff", v)}
          />
          <AxisSegment
            title="本机 Host"
            options={HOST_OPTIONS}
            value={axes.host}
            disabled={disabled || pending}
            onSelect={(v) => patchAxis("host", v)}
          />
        </div>
      )}

      {hint && (
        <p
          className="hint"
          data-testid="permission-hint"
          style={{
            color: hint.includes("失败") ? "var(--error)" : "var(--success)",
          }}
        >
          {hint}
        </p>
      )}

      <button
        type="button"
        className="sheet-item sheet-cancel"
        onClick={onClose}
      >
        完成
      </button>
    </Modal>
  );
}

function AxisSegment<T extends string>({
  title,
  options,
  value,
  onSelect,
  disabled,
  disabledOption,
  disabledReason,
}: {
  title: string;
  options: { value: T; short: string; description: string }[];
  value: T;
  onSelect: (v: T) => void;
  disabled?: boolean;
  disabledOption?: (v: T) => boolean;
  disabledReason?: string;
}) {
  return (
    <div className="permission-axis">
      <p className="permission-section-label">{title}</p>
      <div className="permission-axis-options" aria-label={title}>
        {options.map((opt) => {
          const selected = opt.value === value;
          const blocked = disabledOption?.(opt.value) ?? false;
          return (
            <button
              key={opt.value}
              type="button"
              title={
                blocked ? (disabledReason ?? opt.description) : opt.description
              }
              disabled={disabled || blocked}
              aria-pressed={selected}
              className={
                selected ? "permission-chip selected" : "permission-chip"
              }
              onClick={() => onSelect(opt.value)}
            >
              {opt.short}
            </button>
          );
        })}
      </div>
      {disabledReason && options.some((o) => disabledOption?.(o.value)) ? (
        <p className="muted hint">{disabledReason}</p>
      ) : null}
    </div>
  );
}
