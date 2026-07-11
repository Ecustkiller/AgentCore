export type OnboardingPreviewScene = {
  id: string;
  title: string;
  intent: string;
  /** Full-page wizard step, or draft empty-state kind. */
  kind:
    | "onboarding-value"
    | "onboarding-connect"
    | "onboarding-probing"
    | "empty-needs-key"
    | "empty-starter-chips"
    | "empty-returning";
};

export const ONBOARDING_PREVIEW_SCENES: readonly OnboardingPreviewScene[] = [
  {
    id: "onboarding-value",
    title: "首启 · 价值一屏",
    intent: "AI 团队协作心智，非单 Agent",
    kind: "onboarding-value",
  },
  {
    id: "onboarding-connect",
    title: "首启 · 模型接入",
    intent: "厂商预设 + Key 表单（共享 ModelKeyForm）",
    kind: "onboarding-connect",
  },
  {
    id: "onboarding-probing",
    title: "首启 · 测连通等待",
    intent: "能力介绍轮播，非裸 spinner",
    kind: "onboarding-probing",
  },
  {
    id: "empty-needs-key",
    title: "空态 · 未配 key",
    intent: "引导连接模型 + 产品手册",
    kind: "empty-needs-key",
  },
  {
    id: "empty-starter-chips",
    title: "空态 · 首启任务",
    intent: "三枚多 Agent 任务 chips",
    kind: "empty-starter-chips",
  },
  {
    id: "empty-returning",
    title: "空态 · 老用户",
    intent: "单句零噪音",
    kind: "empty-returning",
  },
];
