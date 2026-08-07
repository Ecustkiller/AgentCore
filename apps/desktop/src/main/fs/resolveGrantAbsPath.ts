/**
 * Grant-chain path resolver (C1 phase 0–1): well_known / target_name / path → abs.
 * Zero showOpenDialog — unresolved → structured failure (not picker fallback).
 */
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { GrantSessionWellKnown } from "@shared/ipc-contract";
import { matchTargetName } from "./matchTargetName";

export type GrantAbsResolveOk = {
  ok: true;
  absPath: string;
  displayLabel: string;
};

export type GrantAbsResolveFail = {
  ok: false;
  reason: "not_found" | "not_directory" | "ambiguous";
};

export type GrantAbsResolveResult = GrantAbsResolveOk | GrantAbsResolveFail;

export type ResolveGrantAbsPathInput = {
  path?: string;
  wellKnown?: GrantSessionWellKnown;
  targetName?: string;
  /** Resolve Electron `app.getPath` keys (injected for tests). */
  resolveWellKnown: (key: GrantSessionWellKnown) => Promise<string>;
};

const WELL_KNOWN_LABEL_ZH: Record<GrantSessionWellKnown, string> = {
  desktop: "桌面",
  downloads: "下载",
  documents: "文档",
};

async function realpathOrSelf(absPath: string): Promise<string> {
  try {
    return await fs.realpath(absPath);
  } catch {
    return absPath;
  }
}

/** Card/IPC displayLabel — never full abs; well_known+child →「桌面 › 咨询」. */
function displayLabelFor(
  absPath: string,
  wellKnown?: GrantSessionWellKnown,
  targetName?: string,
): string {
  const base = basename(absPath) || absPath;
  if (wellKnown && targetName) {
    return `${WELL_KNOWN_LABEL_ZH[wellKnown]} › ${base}`;
  }
  if (wellKnown && !targetName) {
    return WELL_KNOWN_LABEL_ZH[wellKnown];
  }
  return base;
}

async function classifyExistingPath(
  candidate: string,
  wellKnown?: GrantSessionWellKnown,
  targetName?: string,
): Promise<GrantAbsResolveResult> {
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(candidate);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "not_directory" };
  }
  const absPath = await realpathOrSelf(candidate);
  return {
    ok: true,
    absPath,
    displayLabel: displayLabelFor(absPath, wellKnown, targetName),
  };
}

/**
 * Resolve a grant target without any folder picker.
 *
 * Priority: explicit `path` → `wellKnown` (+ optional `targetName`) → not_found.
 */
export async function resolveGrantAbsPath(
  input: ResolveGrantAbsPathInput,
): Promise<GrantAbsResolveResult> {
  const trimmedPath =
    typeof input.path === "string" ? input.path.trim() : undefined;
  if (trimmedPath) {
    // Only absolute paths — no CWD-relative guess.
    if (!isAbsolute(trimmedPath)) {
      return { ok: false, reason: "not_found" };
    }
    // Explicit path → basename only (no well_known prefix on the label).
    return classifyExistingPath(trimmedPath);
  }

  if (!input.wellKnown) {
    return { ok: false, reason: "not_found" };
  }

  let wellKnownAbs: string;
  try {
    wellKnownAbs = await realpathOrSelf(
      await input.resolveWellKnown(input.wellKnown),
    );
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (!input.targetName) {
    return classifyExistingPath(wellKnownAbs, input.wellKnown);
  }

  let entries: { name: string; isDirectory: boolean }[];
  try {
    const dirents = await fs.readdir(wellKnownAbs, { withFileTypes: true });
    entries = dirents.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    }));
  } catch {
    return { ok: false, reason: "not_found" };
  }

  const matched = matchTargetName(entries, input.targetName);
  if (matched.status === "none") {
    return { ok: false, reason: "not_found" };
  }
  if (matched.status === "ambiguous") {
    return { ok: false, reason: "ambiguous" };
  }
  if (!matched.isDirectory) {
    return { ok: false, reason: "not_directory" };
  }
  return classifyExistingPath(
    join(wellKnownAbs, matched.name),
    input.wellKnown,
    input.targetName,
  );
}
