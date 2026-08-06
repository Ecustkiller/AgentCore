/**
 * Fixed local-picker failure kinds (B4 / aa51904b) — copy aligned with desktop
 * `bindLocalFolder.localPickerFailureCopy`. Mobile has no local FS picker; folder
 * Ask actions surface at least `unavailable` via LocalPickerFailureCard.
 */

export type LocalPickerFailureKind =
  | "dialog_failed"
  | "unauthorized"
  | "no_package_json"
  | "unavailable"
  | "error";

export type LocalPickerFailureCopy = {
  title: string;
  detail: string;
};

const LOCAL_PICKER_FAILURE_COPY: Record<
  LocalPickerFailureKind,
  LocalPickerFailureCopy
> = {
  dialog_failed: {
    title: "未弹出文件夹选择器",
    detail:
      "系统未能打开目录选择对话框。请确认窗口在前台后重试；不要连续空点「请选择」。",
  },
  unauthorized: {
    title: "未能授权本机目录",
    detail:
      "所选路径无法访问或未能登记为授权根。请换一个可访问的文件夹后重试。",
  },
  no_package_json: {
    title: "所选目录没有 package.json",
    detail:
      "请选择项目根目录（含 package.json 的文件夹），而不是空目录、压缩包解压不全的目录或上级目录。",
  },
  unavailable: {
    title: "本机目录仅桌面端可用",
    detail: "请在桌面客户端中打开本对话后再选择本机文件夹。",
  },
  error: {
    title: "本机目录操作失败",
    detail: "请重试；若反复失败，换一个文件夹或重启客户端。",
  },
};

export function localPickerFailureCopy(
  kind: LocalPickerFailureKind,
  message?: string,
): LocalPickerFailureCopy {
  const base = LOCAL_PICKER_FAILURE_COPY[kind];
  if (kind === "error" && message?.trim()) {
    return { title: base.title, detail: message.trim() };
  }
  if (
    (kind === "dialog_failed" || kind === "unauthorized") &&
    message?.trim()
  ) {
    return { title: base.title, detail: message.trim() };
  }
  return base;
}

export function isLocalPickerFailureKind(
  reason: string,
): reason is LocalPickerFailureKind {
  return (
    reason === "dialog_failed" ||
    reason === "unauthorized" ||
    reason === "no_package_json" ||
    reason === "unavailable" ||
    reason === "error"
  );
}

/** AskOption.action：须桌面本地文件能力履约，手机禁止退化成普通 choice 确认。 */
export function isDesktopFolderAction(
  action: string | null | undefined,
): boolean {
  return (
    action === "open_local_project" ||
    action === "bind_local_folder" ||
    action === "grant_readonly_folder" ||
    action === "grant_organize_folder"
  );
}
