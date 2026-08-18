import { Badge } from "@/components/ui";
import { Crown, Shield, UserCog } from "lucide-react";
import type { MemberGovernanceBadge } from "./chatDisplay";

const ICONS = {
  platform: UserCog,
  owner: Crown,
  admin: Shield,
} as const;

interface Props {
  badge: MemberGovernanceBadge;
  /** Bubble / tight row: shortLabel. Roster: full label. */
  compact?: boolean;
}

/**
 * Group governance chip — icon shape carries rank (冠 / 盾 / 齿轮),
 * not a new gold token. Platform uses primary; 群主/管理员 stay muted.
 * Do not reuse BadgeCheck (官方号 verified).
 */
export function GovernanceBadge({ badge, compact = false }: Props) {
  const Icon = ICONS[badge.kind];
  return (
    <Badge
      tone={badge.kind === "platform" ? "primary" : "muted"}
      pill
      className="gap-0.5"
      aria-label={badge.label}
    >
      <Icon size={12} aria-hidden className="shrink-0" />
      {compact ? badge.shortLabel : badge.label}
    </Badge>
  );
}
