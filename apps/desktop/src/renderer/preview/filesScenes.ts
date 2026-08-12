import type { AlwaysQuota, DocumentNode } from "@/services/documents";

/** Offline mock rows for `#/preview/files` — flat entries, no 记忆/规则/文档 folders. */
export const FILES_PREVIEW_SCENES = [
  {
    id: "files-entries-rail",
    title: "条目轨",
    description: "全局 + 项目扁平条目 · 常驻用量 · 徽章 · description · 不生效",
  },
] as const;

export type FilesPreviewSceneId = (typeof FILES_PREVIEW_SCENES)[number]["id"];

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
    },
  ];
}

export function buildAlwaysQuotaMock(used: number, max: number): AlwaysQuota {
  return {
    usedChars: used,
    maxChars: max,
    percent: max > 0 ? Math.round((1000 * used) / max) / 10 : 0,
  };
}
