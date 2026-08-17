import {
  conversationUiGet,
  conversationUiRemove,
  conversationUiSet,
} from "@/lib/uiStorage";
import { useCallback, useState } from "react";

export type TeamPreviewKickoffMode = "confirm" | "adjust";

export type TeamPreviewKickoffDraft = {
  mode: TeamPreviewKickoffMode;
  continueNote: string;
  adjustNote: string;
};

export const EMPTY_TEAM_PREVIEW_KICKOFF_DRAFT: TeamPreviewKickoffDraft = {
  mode: "confirm",
  continueNote: "",
  adjustNote: "",
};

function draftLeaf(checkpointId: string): string {
  return `kickoff-draft:${checkpointId}`;
}

function isDraft(value: unknown): value is TeamPreviewKickoffDraft {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.mode === "confirm" || row.mode === "adjust") &&
    typeof row.continueNote === "string" &&
    typeof row.adjustNote === "string"
  );
}

export function loadTeamPreviewKickoffDraft(
  conversationId: string,
  checkpointId: string,
): TeamPreviewKickoffDraft {
  const raw = conversationUiGet<unknown>(
    conversationId,
    draftLeaf(checkpointId),
  );
  return isDraft(raw) ? raw : EMPTY_TEAM_PREVIEW_KICKOFF_DRAFT;
}

export function persistTeamPreviewKickoffDraft(
  conversationId: string,
  checkpointId: string,
  draft: TeamPreviewKickoffDraft,
): void {
  const empty =
    draft.mode === "confirm" &&
    !draft.continueNote.trim() &&
    !draft.adjustNote.trim();
  if (empty) {
    conversationUiRemove(conversationId, draftLeaf(checkpointId));
    return;
  }
  conversationUiSet(conversationId, draftLeaf(checkpointId), draft);
}

export function clearTeamPreviewKickoffDraft(
  conversationId: string,
  checkpointId: string,
): void {
  conversationUiRemove(conversationId, draftLeaf(checkpointId));
}

/** Confirm / adjust drafts keyed by checkpoint — survives switch + reconnect. */
export function useTeamPreviewKickoffDraft(
  conversationId: string,
  checkpointId: string,
) {
  const [draft, setDraft] = useState(() =>
    loadTeamPreviewKickoffDraft(conversationId, checkpointId),
  );

  const update = useCallback(
    (patch: Partial<TeamPreviewKickoffDraft>) => {
      setDraft((prev) => {
        const next = { ...prev, ...patch };
        persistTeamPreviewKickoffDraft(conversationId, checkpointId, next);
        return next;
      });
    },
    [checkpointId, conversationId],
  );

  const discardAdjust = useCallback(() => {
    update({ mode: "confirm", adjustNote: "" });
  }, [update]);

  return { draft, update, discardAdjust };
}
