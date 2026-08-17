import { Modal } from "@/components/Modal";
import { ChevronRight } from "lucide-react";

/**
 * Composer「＋」更多选项 sheet — 会话当前配置收纳处（对齐桌面 bar Plus 清单过滤）。
 * 仅列出手机有能力的项：模型组合、本会话权限、@ 引用。
 */
export function ComposerMoreSheet({
  modelLabel,
  modelPreset,
  permissionLabel,
  disabled,
  onClose,
  onOpenModel,
  onOpenPermission,
  onOpenMention,
}: {
  modelLabel: string;
  modelPreset: boolean;
  permissionLabel: string;
  disabled?: boolean;
  onClose: () => void;
  onOpenModel: () => void;
  onOpenPermission: () => void;
  onOpenMention: () => void;
}) {
  const modelName = `模型组合：${modelLabel}${modelPreset ? "（系统预置）" : ""}`;
  return (
    <Modal className="sheet" onClose={onClose} label="更多选项">
      <div className="sheet-title">更多</div>

      <button
        type="button"
        className="more-row"
        disabled={disabled}
        data-testid="composer-more-model"
        aria-label={modelName}
        onClick={onOpenModel}
      >
        <div className="more-row-main">
          <span className="more-row-title">模型组合</span>
          <span className="more-row-sub muted more-row-sub-badged">
            <span className="more-row-sub-text">{modelLabel}</span>
            {modelPreset && <span className="model-preset-badge">预置</span>}
          </span>
        </div>
        <ChevronRight size={16} className="muted" aria-hidden />
      </button>

      <button
        type="button"
        className="more-row"
        disabled={disabled}
        data-testid="composer-more-permission"
        aria-label={`权限：${permissionLabel}`}
        onClick={onOpenPermission}
      >
        <div className="more-row-main">
          <span className="more-row-title">本会话权限</span>
          <span className="more-row-sub muted">{permissionLabel}</span>
        </div>
        <ChevronRight size={16} className="muted" aria-hidden />
      </button>

      <button
        type="button"
        className="more-row"
        disabled={disabled}
        data-testid="composer-more-mention"
        aria-label="@ 引用"
        onClick={onOpenMention}
      >
        <div className="more-row-main">
          <span className="more-row-title">@ 引用</span>
          <span className="more-row-sub muted">附件、团队、对话、文件</span>
        </div>
        <ChevronRight size={16} className="muted" aria-hidden />
      </button>

      <button
        type="button"
        className="sheet-item sheet-cancel"
        onClick={onClose}
      >
        取消
      </button>
    </Modal>
  );
}
