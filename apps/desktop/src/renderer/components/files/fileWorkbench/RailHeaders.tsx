import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { pickAndOpenLocalFolder } from "@/lib/openLocalFolder";
import { HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/**
 * A rail zone title (我的文件 / 本机文件夹 / 与我共享) plus, for 本机文件夹,
 * the one disk action that still belongs on the header. Cloud product folders
 * are created from Composer, not from this rail.
 */
export function RailSectionHeader({
  label,
  action,
}: {
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 px-2 pb-0.5 pt-3">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {action}
    </div>
  );
}

/** 我的文件 — the cloud folder tree. Create goes through Composer. */
export function MyFilesRailHeader() {
  return <RailSectionHeader label="我的文件" />;
}

/** 本机文件夹 — disk folders opened before, newest activity first (VS Code 语义). */
export function LocalFoldersRailHeader() {
  const navigate = useNavigate();

  return (
    <RailSectionHeader
      label="本机文件夹"
      action={
        <SimpleTooltip label="打开本机文件夹">
          <IconButton
            aria-label="打开本机文件夹"
            onClick={() => void pickAndOpenLocalFolder(navigate)}
          >
            <HardDrive size={13} />
          </IconButton>
        </SimpleTooltip>
      }
    />
  );
}

/** 与我共享 — cloud desks this user joined. Invite lives on the owner's folder. */
export function SharedWithMeRailHeader() {
  return <RailSectionHeader label="与我共享" />;
}
