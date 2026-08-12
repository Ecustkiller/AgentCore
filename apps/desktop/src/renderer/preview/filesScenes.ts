import type { AlwaysQuota, DocumentNode } from "@/services/documents";

/** Offline mock scenes for `#/preview/files` — always-usage states for shoot review. */
export const FILES_PREVIEW_SCENES = [
  {
    id: "files-quota-empty",
    title: "用量 · 空态",
    description: "新账号 0 字 · 空画像/偏好 · 还没占用",
  },
  {
    id: "files-quota-normal",
    title: "用量 · 常态",
    description: "还剩多少 · 行内字数 · 徽章解释",
  },
  {
    id: "files-quota-near-full",
    title: "用量 · 接近满",
    description: "快满后果文案 · 去整理出口",
  },
  {
    id: "files-quota-over",
    title: "用量 · 已超限",
    description: "已超后果文案 · 去整理出口",
  },
  {
    id: "files-quota-project-split",
    title: "用量 · 项目两段",
    description: "含全局两段条 · tooltip 解色",
  },
] as const;

export type FilesPreviewSceneId = (typeof FILES_PREVIEW_SCENES)[number]["id"];

export const FILES_PREVIEW_PROJECT_FOLDER_ID = "folder-demo";

const MAX_CHARS = 24000;

export function buildGlobalEntriesMock(): DocumentNode[] {
  return [
    {
      id: "g-pref",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "沟通与工作习惯",
      name: "偏好.md",
      frontmatterError: null,
      alwaysChars: 1200,
    },
    {
      id: "g-profile",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "用户长期事实",
      name: "画像.md",
      frontmatterError: null,
      alwaysChars: 800,
    },
    {
      id: "g-rule",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: false,
      applyMode: "always",
      description: "回复语气与禁忌",
      name: "语气.md",
      frontmatterError: null,
      alwaysChars: 2200,
    },
    {
      id: "g-ondemand",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: false,
      applyMode: "on_demand",
      description: "偶发合规附录",
      name: "合规附录.md",
      frontmatterError: null,
      alwaysChars: null,
    },
    {
      id: "g-bad",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: false,
      applyMode: "on_demand",
      description: "",
      name: "坏条目.md",
      frontmatterError: "unclosed frontmatter",
      alwaysChars: null,
    },
  ];
}

/** New-account / empty cores — real rows with 0 always chars. */
export function buildEmptyGlobalEntriesMock(): DocumentNode[] {
  return [
    {
      id: "g-pref-empty",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "",
      name: "偏好.md",
      frontmatterError: null,
      alwaysChars: 0,
    },
    {
      id: "g-profile-empty",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "",
      name: "画像.md",
      frontmatterError: null,
      alwaysChars: 0,
    },
  ];
}

export function buildProjectEntriesMock(folderId: string): DocumentNode[] {
  return [
    {
      id: "p-profile",
      parentId: null,
      folderId,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "本项目技术栈与事实",
      name: "画像.md",
      frontmatterError: null,
      alwaysChars: 3200,
    },
    {
      id: "p-nav",
      parentId: null,
      folderId,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "一句话定位 + 任务路由",
      name: "导航.md",
      frontmatterError: null,
      alwaysChars: 2400,
    },
    {
      id: "p-topic",
      parentId: null,
      folderId,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "on_demand",
      description: "部署流程备忘",
      name: "主题/部署流程.md",
      frontmatterError: null,
      alwaysChars: null,
    },
  ];
}

export function buildEmptyProjectEntriesMock(folderId: string): DocumentNode[] {
  return [
    {
      id: "p-profile-empty",
      parentId: null,
      folderId,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "",
      name: "画像.md",
      frontmatterError: null,
      alwaysChars: 0,
    },
    {
      id: "p-nav-empty",
      parentId: null,
      folderId,
      kind: "document",
      role: "rule",
      aiMaintained: true,
      applyMode: "always",
      description: "",
      name: "导航.md",
      frontmatterError: null,
      alwaysChars: 0,
    },
  ];
}

export function buildAlwaysQuotaMock(input: {
  used: number;
  max: number;
  globalChars: number;
  projectChars: number;
}): AlwaysQuota {
  const { used, max, globalChars, projectChars } = input;
  return {
    usedChars: used,
    maxChars: max,
    percent: max > 0 ? Math.round((1000 * used) / max) / 10 : 0,
    globalChars,
    projectChars,
  };
}

export function entriesForScene(sceneId: FilesPreviewSceneId): {
  global: DocumentNode[];
  project: DocumentNode[];
} {
  const folderId = FILES_PREVIEW_PROJECT_FOLDER_ID;
  if (sceneId === "files-quota-empty") {
    return {
      global: buildEmptyGlobalEntriesMock(),
      project: buildEmptyProjectEntriesMock(folderId),
    };
  }
  return {
    global: buildGlobalEntriesMock(),
    project: buildProjectEntriesMock(folderId),
  };
}

/** Quota fixtures keyed by scene — global meter + project meter. */
export function alwaysQuotaForScene(sceneId: FilesPreviewSceneId): {
  global: AlwaysQuota;
  project: AlwaysQuota;
} {
  switch (sceneId) {
    case "files-quota-empty":
      return {
        global: buildAlwaysQuotaMock({
          used: 0,
          max: MAX_CHARS,
          globalChars: 0,
          projectChars: 0,
        }),
        project: buildAlwaysQuotaMock({
          used: 0,
          max: MAX_CHARS,
          globalChars: 0,
          projectChars: 0,
        }),
      };
    case "files-quota-near-full":
      return {
        global: buildAlwaysQuotaMock({
          used: 20000,
          max: MAX_CHARS,
          globalChars: 20000,
          projectChars: 0,
        }),
        project: buildAlwaysQuotaMock({
          used: 22000,
          max: MAX_CHARS,
          globalChars: 20000,
          projectChars: 2000,
        }),
      };
    case "files-quota-over":
      return {
        global: buildAlwaysQuotaMock({
          used: 28000,
          max: MAX_CHARS,
          globalChars: 28000,
          projectChars: 0,
        }),
        project: buildAlwaysQuotaMock({
          used: 32000,
          max: MAX_CHARS,
          globalChars: 28000,
          projectChars: 4000,
        }),
      };
    case "files-quota-project-split":
      // Keep under the near-full threshold so the two-tone bar is the focus.
      return {
        global: buildAlwaysQuotaMock({
          used: 4200,
          max: MAX_CHARS,
          globalChars: 4200,
          projectChars: 0,
        }),
        project: buildAlwaysQuotaMock({
          used: 9800,
          max: MAX_CHARS,
          globalChars: 4200,
          projectChars: 5600,
        }),
      };
    default:
      return {
        global: buildAlwaysQuotaMock({
          used: 4200,
          max: MAX_CHARS,
          globalChars: 4200,
          projectChars: 0,
        }),
        project: buildAlwaysQuotaMock({
          used: 5600,
          max: MAX_CHARS,
          globalChars: 4200,
          projectChars: 1400,
        }),
      };
  }
}
