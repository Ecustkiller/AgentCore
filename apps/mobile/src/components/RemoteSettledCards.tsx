/**
 * 「已由另一端处理」提示条（云对话多端同权 B2 · P1 · 验收 5）。
 *
 * 另一端点掉的卡不直接消失，就地换成这张只读条：卡凭空不见会让用户以为是自己刚点的，
 * 也解释不了 AI 为什么自己往下跑了。手机自建 UI（cross-platform-frontend.mdc：不共享组件）。
 */
import {
  REMOTE_SETTLED_TEXT,
  type RemoteSettlement,
  dismissRemoteSettlement,
  interactionLabel,
  useRemoteSettlements,
} from "@/lib/remoteSettlement";

export function RemoteSettledCards({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const entries = useRemoteSettlements(conversationId);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => (
        <RemoteSettledCard key={entry.interactionId} entry={entry} />
      ))}
    </>
  );
}

function RemoteSettledCard({ entry }: { entry: RemoteSettlement }) {
  return (
    <div
      className="pause pause-settled"
      data-testid="remote-settled-card"
      data-interaction-id={entry.interactionId}
      // biome-ignore lint/a11y/useSemanticElements: 内嵌「知道了」按钮，<output> 语义不符——保留 aria live 容器。
      role="status"
    >
      <div className="pause-title">{interactionLabel(entry.kind)}</div>
      <div className="pause-context">{REMOTE_SETTLED_TEXT}</div>
      <div className="pause-hint">你在另一台设备上做了决定，这里无需再点。</div>
      <div className="pause-actions">
        <button
          type="button"
          className="pause-btn pause-btn-neutral"
          onClick={() => dismissRemoteSettlement(entry.interactionId)}
        >
          知道了
        </button>
      </div>
    </div>
  );
}
