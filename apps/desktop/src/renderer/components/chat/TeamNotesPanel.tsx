import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import type { TeamNote } from "@/stores/execution";
import { StickyNote } from "lucide-react";

/** 团队便签墙 (§2.2 通) note kind → 中文 label + tone. `decision` (我定了) is a choice others must
 * depend on (an interface / field name / format / naming); `heads_up` (提个醒) is a pitfall /
 * discovery worth flagging; `claim` (我领了) is a piece of work / file this worker is taking, so a
 * sibling doesn't duplicate it (success tone reads as「已认领」, distinct from decision's brand blue
 * and heads_up's caution amber). Mirrors the backend NoteWall labels (runtime/runs/notewall.py);
 * an unknown kind falls back to 提个醒 (the lower-commitment one, matching the backend coercion). */
const NOTE_KIND_META: Record<string, { label: string; className: string }> = {
  decision: { label: "我定了", className: "bg-primary/10 text-primary" },
  heads_up: { label: "提个醒", className: "bg-muted text-muted-foreground" },
  claim: { label: "我领了", className: "bg-success/10 text-success" },
};

/** 便签会过期 → supersession (§2.2): a note marked `superseded` (改写) / `voided` (作废) is shown
 * struck-through + dimmed with this badge, so a reader never mistakes a stale decision for current
 * truth. `active` notes carry no status badge. */
const NOTE_STATUS_META: Record<string, { label: string; className: string }> = {
  superseded: { label: "已更新", className: "bg-muted text-muted-foreground" },
  voided: { label: "已作废", className: "bg-destructive/10 text-destructive" },
};

/**
 * 团队便签墙 (§2.2 通) — the in-chat「团队便签」panel: the one-line decisions / heads-ups workers
 * broadcast to their CONCURRENT siblings via `post_note` WHILE they worked (`team_note_posted` →
 * {@link Execution.teamNotes}). This is the visible, glass-box face of the note wall — and what
 * makes it worth more than direct chat: every broadcast is a recorded, attributed, kind-tagged
 * fact shown in ONE place, not a conversation. Each note is fire-and-forget (贴事实·不要求回应),
 * shown with its author (谁贴的) and kind (我定了 / 提个醒), in post order. Renders nothing for a
 * turn that posted no notes (the common case), so it is pure addition over today's behaviour.
 */
export function TeamNotesPanel({ notes }: { notes: TeamNote[] }) {
  if (notes.length === 0) return null;
  return (
    <section className="border-t border-border px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <StickyNote size={14} className="shrink-0" />
        <span className="flex-1">团队便签</span>
        <span className="tabular-nums">{notes.length}</span>
      </div>
      <ul className="space-y-1.5">
        {notes.map((note) => (
          <NoteRow key={note.noteId} note={note} />
        ))}
      </ul>
    </section>
  );
}

/** One sticky note: the author's identity disc + role, a kind badge (我定了 / 提个醒), and the
 *  one-line broadcast text. Identity color is derived from the role (角色身份, agentIdentity) so a
 *  note reads as「同一拨人」with its graph node. */
function NoteRow({ note }: { note: TeamNote }) {
  const kind = NOTE_KIND_META[note.kind] ?? NOTE_KIND_META.heads_up;
  const author = note.role || note.agentId;
  const status = NOTE_STATUS_META[note.status];
  const stale = status != null;
  return (
    <li
      className={`flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2 ${stale ? "opacity-60" : ""}`}
    >
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={{
          backgroundColor: `color-mix(in oklab, ${agentColorVar(author)} 18%, transparent)`,
          color: agentColorVar(author),
        }}
        aria-hidden
      >
        {agentGlyph(author)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {author}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${kind.className}`}
          >
            {kind.label}
          </span>
          {status && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${status.className}`}
            >
              {status.label}
            </span>
          )}
          {note.source === "ceo" && (
            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
              主 Agent 播种
            </span>
          )}
        </div>
        <p
          className={`whitespace-pre-wrap break-words text-sm leading-snug text-foreground ${stale ? "line-through" : ""}`}
        >
          {note.text}
        </p>
      </div>
    </li>
  );
}
