import { folderCollaboratorsLabel } from "@/services/folders";
import { Users } from "lucide-react";
import type { MouseEvent } from "react";

/** People mark on the owner's own desk root. Never says「已共享」. */
export function FolderCollabMark({
  count,
  onClick,
}: {
  count: number;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const label = folderCollaboratorsLabel(count);
  if (onClick) {
    return (
      <button
        type="button"
        title={label}
        onClick={onClick}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Users size={12} aria-hidden />
        <span className="sr-only">{label}</span>
      </button>
    );
  }
  return (
    <span className="inline-flex shrink-0 text-muted-foreground" title={label}>
      <Users size={12} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
