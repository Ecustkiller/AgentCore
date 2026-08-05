// Session permission axes (PUT /v1/conversations/{id}/permission-axes) + recipe helpers.
// Mirrors desktop permissionAxes.ts behaviour; mobile-owned copy (no cross-app import).
import { setAutonomy } from "@/api/autonomy";
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

export type PermissionAxes = Schemas["PermissionAxesModel"];
export type AutonomyRecipe = Schemas["AutonomyPolicy"];

export const DEFAULT_PERMISSION_AXES: PermissionAxes = {
  file_write: "session",
  command: "auto",
  team_kickoff: "rules",
  host: "session",
};

export const RECIPE_AXES: Record<AutonomyRecipe, PermissionAxes> = {
  cautious: {
    file_write: "ask",
    command: "ask",
    team_kickoff: "rules",
    host: "off",
  },
  less_interrupt: DEFAULT_PERMISSION_AXES,
  managed: {
    file_write: "session",
    command: "auto",
    team_kickoff: "skip",
    host: "session",
  },
};

export const RECIPE_ORDER: AutonomyRecipe[] = [
  "cautious",
  "less_interrupt",
  "managed",
];

export const RECIPE_LABELS: Record<
  AutonomyRecipe,
  { short: string; description: string }
> = {
  cautious: {
    short: "谨慎",
    description: "改文件每次问 · 执行每次确认 · 组队按规则 · 本机关闭",
  },
  less_interrupt: {
    short: "少打断",
    description: "改文件本会话信任 · 自动执行 · 组队按规则 · 本机会话信任",
  },
  managed: {
    short: "托管",
    description: "改文件本会话信任 · 自动执行 · 不弹组队卡 · 本机会话信任",
  },
};

export const FILE_WRITE_OPTIONS: {
  value: PermissionAxes["file_write"];
  short: string;
  description: string;
}[] = [
  {
    value: "ask",
    short: "每次确认",
    description: "每次改文件都要你确认。",
  },
  {
    value: "session",
    short: "本会话信任",
    description: "本会话内可逆写入免逐次确认。",
  },
];

export const COMMAND_OPTIONS: {
  value: PermissionAxes["command"];
  short: string;
  description: string;
}[] = [
  {
    value: "ask",
    short: "每次确认",
    description: "不挂开工执行授权；执行类仍逐次审。",
  },
  {
    value: "kickoff",
    short: "开工时确认",
    description: "在开工卡上确认后，本回合可跑代码/终端。",
  },
  {
    value: "auto",
    short: "自动执行",
    description: "执行类（代码/终端/浏览器等）免审；Host/MCP 仍按本机轴。",
  },
];

export const TEAM_KICKOFF_OPTIONS: {
  value: PermissionAxes["team_kickoff"];
  short: string;
  description: string;
}[] = [
  {
    value: "always",
    short: "总是确认",
    description: "组队前总是先给你看组团卡。",
  },
  {
    value: "rules",
    short: "重要时确认",
    description: "按现行规则决定是否弹出组团卡。",
  },
  {
    value: "skip",
    short: "不弹组队卡",
    description: "组队不弹组团卡。",
  },
];

export const HOST_OPTIONS: {
  value: PermissionAxes["host"];
  short: string;
  description: string;
}[] = [
  {
    value: "off",
    short: "关闭",
    description: "本机 Host 面整面关闭（不影响工作区终端）。",
  },
  {
    value: "ask",
    short: "每次确认",
    description: "本机 Host 敏感操作逐次确认。",
  },
  {
    value: "session",
    short: "本会话信任",
    description: "本会话信任本机 Host（熔断除外）。",
  },
];

const FILE_WRITE_BADGE: Record<PermissionAxes["file_write"], string> = {
  ask: "逐次",
  session: "信任",
};
const COMMAND_BADGE: Record<PermissionAxes["command"], string> = {
  ask: "每次",
  kickoff: "开工",
  auto: "免审",
};
const TEAM_KICKOFF_BADGE: Record<PermissionAxes["team_kickoff"], string> = {
  always: "总挂",
  rules: "规则",
  skip: "跳卡",
};
const HOST_BADGE: Record<PermissionAxes["host"], string> = {
  off: "本机关",
  ask: "本机问",
  session: "本机信",
};

export function axesEqual(a: PermissionAxes, b: PermissionAxes): boolean {
  return (
    a.file_write === b.file_write &&
    a.command === b.command &&
    a.team_kickoff === b.team_kickoff &&
    a.host === b.host
  );
}

/** Illegal: command=auto ∧ file_write=ask. */
export function isIllegalAxes(axes: PermissionAxes): boolean {
  return axes.command === "auto" && axes.file_write === "ask";
}

export function normalizeAxes(
  raw: Partial<PermissionAxes> | null | undefined,
): PermissionAxes {
  const next: PermissionAxes = {
    file_write: raw?.file_write ?? DEFAULT_PERMISSION_AXES.file_write,
    command: raw?.command ?? DEFAULT_PERMISSION_AXES.command,
    team_kickoff: raw?.team_kickoff ?? DEFAULT_PERMISSION_AXES.team_kickoff,
    host: raw?.host ?? DEFAULT_PERMISSION_AXES.host,
  };
  if (isIllegalAxes(next)) return { ...DEFAULT_PERMISSION_AXES };
  return next;
}

export function recipeToAxes(recipe: AutonomyRecipe): PermissionAxes {
  return { ...RECIPE_AXES[recipe] };
}

export function matchRecipe(axes: PermissionAxes): AutonomyRecipe | "custom" {
  for (const id of RECIPE_ORDER) {
    if (axesEqual(axes, RECIPE_AXES[id])) return id;
  }
  return "custom";
}

export function axesCustomSummary(axes: PermissionAxes): string {
  return [
    FILE_WRITE_BADGE[axes.file_write],
    COMMAND_BADGE[axes.command],
    TEAM_KICKOFF_BADGE[axes.team_kickoff],
    HOST_BADGE[axes.host],
  ].join(" · ");
}

export function axesShortLabel(axes: PermissionAxes): string {
  const recipe = matchRecipe(axes);
  return recipe === "custom"
    ? axesCustomSummary(axes)
    : RECIPE_LABELS[recipe].short;
}

export function needsAutoCommandConfirm(
  current: PermissionAxes,
  next: PermissionAxes,
): boolean {
  return next.command === "auto" && current.command !== "auto";
}

const AUTO_CONFIRM =
  "切换到「免审执行」后，执行类（代码/终端/浏览器等）将免审；Host/MCP 仍按本机轴。确定继续？";

export function confirmAutoCommandIfNeeded(
  current: PermissionAxes,
  next: PermissionAxes,
): boolean {
  if (!needsAutoCommandConfirm(current, next)) return true;
  return window.confirm(AUTO_CONFIRM);
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

/** Persist a mid-session axes switch. Returns the saved axes from the summary. */
export async function setConversationPermissionAxes(
  conversationId: string,
  permissionAxes: PermissionAxes,
): Promise<PermissionAxes> {
  if (isIllegalAxes(permissionAxes)) {
    throw new Error("非法权限组合：免审执行须同时「本会话信任」改文件");
  }
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/permission-axes`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission_axes: permissionAxes }),
    },
  );
  if (!res.ok) throw new Error(await errorMessage(res, "切换权限失败"));
  const data = (await res.json()) as {
    permission_axes?: PermissionAxes | null;
  };
  return normalizeAxes(data.permission_axes ?? permissionAxes);
}

/** Persist user-level default recipe (seeds new conversations only). */
export async function setUserDefaultRecipe(
  policy: AutonomyRecipe,
): Promise<AutonomyRecipe> {
  const d = await setAutonomy(policy);
  return d.policy;
}
