export type OnboardingPreviewScene = {
  id: string;
  title: string;
  intent: string;
  /** Full-page wizard step, or draft empty-state kind. */
  kind:
    | "onboarding-value"
    | "onboarding-connect"
    | "onboarding-connect-free-tier"
    | "onboarding-probing"
    | "empty-needs-key"
    | "empty-starter-chips"
    | "empty-returning"
    | "composer-generating-bar"
    | "composer-generating-card";
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
    id: "onboarding-connect-free-tier",
    title: "首启 · 免费额度路径",
    intent: "free_tier_active：先用免费额度 CTA + 配 key 主路",
    kind: "onboarding-connect-free-tier",
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
    intent: "中央 CTA；输入框仍底栏（不居中）",
    kind: "empty-needs-key",
  },
  {
    id: "empty-starter-chips",
    title: "空态 · 首启任务",
    intent: "问候 + chips + 输入框居中成一体",
    kind: "empty-starter-chips",
  },
  {
    id: "empty-returning",
    title: "空态 · 老用户",
    intent: "单句问候 + 输入框居中成一体",
    kind: "empty-returning",
  },
  {
    id: "composer-generating-bar",
    title: "生成中 · 底部条插话",
    intent: "回合执行中：发送=插话，停止键并存（bar 单行）",
    kind: "composer-generating-bar",
  },
  {
    id: "composer-generating-card",
    title: "生成中 · 画布栏插话",
    intent: "回合执行中：画布命令栏（card）同样可插话",
    kind: "composer-generating-card",
  },
];
