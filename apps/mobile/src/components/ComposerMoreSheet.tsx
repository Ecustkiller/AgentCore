import { Modal } from "@/components/Modal";
import { ChevronRight } from "lucide-react";

/**
 * Composer「＋」更多选项 sheet — 会话当前配置收纳处（对齐桌面 bar Plus 清单过滤）。
 * 仅列出手机有能力的项：模型组合、本会话权限、附件。
 */
export function ComposerMoreSheet({
  modelLabel,
  permissionLabel,
  disabled,
  onClose,
  onOpenModel,
  onOpenPermission,
  onAttach,
}: {
  modelLabel: string;
  permissionLabel: string;
  disabled?: boolean;
  onClose: () => void;
  onOpenModel: () => void;
  onOpenPermission: () => void;
  onAttach: () => void;
}) {
  return (
    <Modal className="sheet" onClose={onClose} label="更多选项">
      <div className="sheet-title">更多</div>

      <button
        type="button"
        className="more-row"
        disabled={disabled}
        data-testid="composer-more-model"
        aria-label={`模型组合：${modelLabel}`}
        onClick={onOpenModel}
      >
        <div className="more-row-main">
          <span className="more-row-title">模型组合</span>
          <span className="more-row-sub muted">{modelLabel}</span>
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
        data-testid="composer-more-attach"
        aria-label="附件"
        onClick={onAttach}
      >
        <div className="more-row-main">
          <span className="more-row-title">附件</span>
          <span className="more-row-sub muted">添加文件到本条消息</span>
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
