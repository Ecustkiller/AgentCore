import { Button } from "@/components/ui";
import {
  type StatusTone,
  statusAccentText,
  statusPillSoft,
} from "@/components/ui/tone-presets";
import { pickAndBindLocalFolder } from "@/lib/bindLocalFolder";
import type { DeliveryAction, DeliveryStatusPayload } from "@/types/events";
import { AlertTriangle, FolderOpen, PackageOpen } from "lucide-react";
import { useState } from "react";

/**
 * 「完成条件」卡（批次验收 / completion_criteria）—— 渲染 `delivery_status` 的结构化对账：
 * 完成条件缺口 + 待用户操作（如绑定本地文件夹）。与 finish_guard 的
 * 「引用/格式核验后已重写」chip 是两回事——本卡表示批次验收未过，团队可能重派。
 * 挂在答复正文下方、「本回合产出文件」卡上方。
 *
 * `state=delivered`（有产物、无缺口）不渲染——已交付清单由 FileArtifactsCard 承载，
 * 本卡只在有诚实缺口要交代（partial / blocked）时出现，避免重复噪音。
 * `actions` 里已知的 `bind_local_folder` 渲染为真按钮（复用 ask_user 卡的绑定通路）；
 * 未知 kind 按普通提示行渲染（契约向前兼容）。
 */

const STATE_META: Record<
  "partial" | "blocked",
  { label: string; tone: StatusTone }
> = {
  partial: { label: "部分未满足", tone: "primary" },
  blocked: { label: "未满足", tone: "destructive" },
};

/** Known cutoff / shortfall reason codes on ``DeliveryGap.reason`` (forward-compatible). */
const GAP_REASON_LABEL: Record<string, string> = {
  token_budget: "预算触顶",
  worker_timeout: "运行超时",
  degraded_handoff: "降级交接",
};

function BindActionRow({
  action,
  conversationId,
}: {
  action: DeliveryAction;
  conversationId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [bound, setBound] = useState(false);

  const onBind = async () => {
    if (!conversationId || busy) return;
    setBusy(true);
    setNote(null);
    const result = await pickAndBindLocalFolder(conversationId);
    setBusy(false);
    if (result.ok) {
      setBound(true);
      setNote(`已绑定「${result.root.name}」——在输入框告诉团队继续即可。`);
      return;
    }
    if (result.reason === "error") setNote(result.message);
    else if (result.reason === "unavailable")
      setNote("绑定本地文件夹仅桌面端可用");
    // cancelled → 静默（用户主动关掉选择器）。
  };

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-start gap-2">
        <FolderOpen
          size={14}
          className={`mt-0.5 shrink-0 ${statusAccentText.primary}`}
        />
        <p className="min-w-0 flex-1 text-sm text-foreground">
          {action.description}
        </p>
        {conversationId && !bound && (
          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => void onBind()}
          >
            {busy ? "选择文件夹…" : "绑定本地文件夹"}
          </Button>
        )}
      </div>
      {note && (
        <p
          className={`pl-6 text-xs ${bound ? statusAccentText.success : "text-muted-foreground"}`}
        >
          {note}
        </p>
      )}
    </li>
  );
}

export function DeliveryStatusCard({
  status,
  conversationId = null,
}: {
  status: DeliveryStatusPayload;
  conversationId?: string | null;
}) {
  // 已交付且无缺口：清单由「本回合产出文件」卡承载，本卡不重复出现。
  if (status.state === "delivered") return null;
  const meta = STATE_META[status.state];
  const gaps = status.gaps ?? [];
  const actions = status.actions ?? [];

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <PackageOpen
          size={15}
          className={`shrink-0 ${statusAccentText[meta.tone]}`}
        />
        <span className="text-sm font-medium text-foreground">完成条件</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none ${statusPillSoft[meta.tone]}`}
        >
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {status.summary}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          团队可能重派
        </span>
      </div>
      {gaps.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {gaps.map((gap, i) => {
            const reasonLabel =
              gap.reason && GAP_REASON_LABEL[gap.reason]
                ? GAP_REASON_LABEL[gap.reason]
                : null;
            return (
              <li
                key={`${gap.role}:${i}`}
                className="flex items-start gap-2 px-3 py-2"
              >
                <AlertTriangle
                  size={14}
                  className={`mt-0.5 shrink-0 ${statusAccentText[meta.tone]}`}
                />
                <p className="min-w-0 flex-1 text-sm text-foreground">
                  <span className="text-muted-foreground">{gap.role}：</span>
                  {reasonLabel && (
                    <span
                      className={`mr-1.5 inline-block shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none ${statusPillSoft[meta.tone]}`}
                    >
                      {reasonLabel}
                    </span>
                  )}
                  {gap.description}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {actions.length > 0 && (
        <ul className="divide-y divide-border border-t border-border bg-muted/30">
          {actions.map((action, i) =>
            action.kind === "bind_local_folder" ? (
              <BindActionRow
                key={`${action.kind}:${i}`}
                action={action}
                conversationId={conversationId}
              />
            ) : (
              <li
                key={`${action.kind}:${i}`}
                className="flex items-start gap-2 px-3 py-2"
              >
                <FolderOpen
                  size={14}
                  className={`mt-0.5 shrink-0 ${statusAccentText.primary}`}
                />
                <p className="min-w-0 flex-1 text-sm text-foreground">
                  {action.description}
                </p>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
