/** Attachment + role chips on a user bubble (history / live / draft-pending / interjection).

Role chips are **not** attachments: ``agent_mentions`` stay orthogonal to
``attachments.kind``. Copy is 「点名」— a soft hint, not an assignment.
*/

export type UserBubbleAttachment = { name: string; truncated?: boolean };
export type UserBubbleMention = { agentId?: string; role: string };

export function UserBubbleChips({
  attachments = [],
  agentMentions = [],
}: {
  attachments?: UserBubbleAttachment[];
  agentMentions?: UserBubbleMention[];
}) {
  if (attachments.length === 0 && agentMentions.length === 0) return null;
  return (
    <div className="attach-chips">
      {agentMentions.map((a, i) => (
        <span
          key={a.agentId ?? `${a.role}-${i}`}
          className="attach-chip"
          data-testid="agent-mention-chip"
        >
          <span className="attach-chip-kind">点名</span>
          <span className="attach-chip-name">{a.role}</span>
        </span>
      ))}
      {attachments.map((a, i) => (
        <span key={`${a.name}-${i}`} className="attach-chip">
          <span aria-hidden>📎</span>
          <span className="attach-chip-name">{a.name}</span>
          {a.truncated && <span className="attach-chip-trunc">已截断</span>}
        </span>
      ))}
    </div>
  );
}
