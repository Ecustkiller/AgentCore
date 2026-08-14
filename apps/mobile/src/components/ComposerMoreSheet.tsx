import { Modal } from "@/components/Modal";
import { ChevronRight } from "lucide-react";

/**
 * Composer「＋」更多选项 sheet — 会话当前配置收纳处（对齐桌面 bar Plus 清单过滤）。
 * 仅列出手机有能力的项：本会话权限、@ 引用。模型组合已挂在 composer 行内 chip。
 */
export function ComposerMoreSheet({
  permissionLabel,
  disabled,
  onClose,
  onOpenPermission,
  onOpenMention,
}: {
  permissionLabel: string;
  disabled?: boolean;
  onClose: () => void;
  onOpenPermission: () => void;
  onOpenMention: () => void;
}) {
  return (
    <Modal className="sheet" onClose={onClose} label="更多选项">
      <div className="sheet-title">更多</div>

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
