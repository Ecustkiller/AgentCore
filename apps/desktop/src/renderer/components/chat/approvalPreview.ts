/** Collapsed approval-card body: a few lines, not a document well. */

export const APPROVAL_FACE_LINES = 3;
/** ~3 wrapped lines of xs mono in the composer-width card. */
export const APPROVAL_FACE_CHARS = 180;

/** Logical lines; a trailing newline does not count as an extra row. */
export function countApprovalLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

export function approvalBodyNeedsClip(text: string): boolean {
  return (
    countApprovalLines(text) > APPROVAL_FACE_LINES ||
    text.length > APPROVAL_FACE_CHARS
  );
}

export function firstApprovalLine(text: string): string {
  return text.replace(/\n$/, "").split("\n")[0] ?? "";
}
