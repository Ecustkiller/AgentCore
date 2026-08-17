import {
  KICKOFF_REVISION_META,
  KICKOFF_REVISION_NOTE_CLIP,
  kickoffRevisionHeadline,
  showsKickoffRevision,
} from "@/lib/kickoffRevision";
import { useState } from "react";

function KickoffRevisionNote({
  text,
  noteLabel,
  expand,
  collapse,
}: {
  text: string;
  noteLabel: string;
  expand: string;
  collapse: string;
}) {
  const [open, setOpen] = useState(false);
  const clipped = text.length > KICKOFF_REVISION_NOTE_CLIP;
  const shown =
    !clipped || open ? text : `${text.slice(0, KICKOFF_REVISION_NOTE_CLIP)}…`;
  return (
    <div className="kickoff-revision-note" data-testid="kickoff-revision-note">
      <div className="pause-hint">{noteLabel}</div>
      <div className="pause-context">{shown}</div>
      {clipped ? (
        <button
          type="button"
          className="collapsible-user-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? collapse : expand}
        </button>
      ) : null}
    </div>
  );
}

/** revision≥2：卡头版本 + 意见原文 + 有上一版才画的变更。 */
export function KickoffRevisionBanner({
  revision,
  revisionNote,
  changes,
  primitive = "delegate",
}: {
  revision: number;
  revisionNote: string;
  changes: readonly string[];
  primitive?: "delegate" | "debate";
}) {
  if (!showsKickoffRevision(revision)) return null;
  const copy = KICKOFF_REVISION_META[primitive];
  return (
    <div className="kickoff-revision" data-testid="kickoff-revision">
      <div className="pause-hint" data-testid="kickoff-revision-head">
        {kickoffRevisionHeadline(revision, primitive)}
      </div>
      {revisionNote ? (
        <KickoffRevisionNote
          text={revisionNote}
          noteLabel={copy.noteLabel}
          expand={copy.noteExpand}
          collapse={copy.noteCollapse}
        />
      ) : null}
      {changes.length > 0 ? (
        <div data-testid="kickoff-revision-diff">
          <div className="pause-hint">{copy.changesLead}</div>
          <ul className="kickoff-revision-diff">
            {changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
