// @vitest-environment jsdom
/**
 * Render + interaction tests for the mobile 会话级模型组合 selector (ModelPicker).
 */
import type { LlmProvidersResponse } from "@/api/llmProviders";
import { listLlmProviders } from "@/api/llmProviders";
import type { LlmModelProfileListResponse } from "@/api/modelProfiles";
import type { ModelCatalog } from "@/api/models";
import { ModelPicker } from "@/components/ModelPicker";
import { MODEL_CONFIG_PATH } from "@/lib/errors";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/api/llmProviders", () => ({
  listLlmProviders: vi.fn(),
}));

const PROFILES: LlmModelProfileListResponse = {
  default_model_profile_id: "00000000-0000-4000-8000-000000000011",
  data: [
    {
      id: "00000000-0000-4000-8000-000000000011",
      name: "GLM-5.2",
      kind: "system",
      main: { origin: "platform", model: "glm-5.2", provider_id: null },
      worker: null,
      background: null,
      is_default: true,
    },
    {
      id: "prof-user-1",
      name: "写作强档",
      kind: "user",
      main: {
        origin: "byok",
        model: "deepseek-v4-pro",
        provider_id: "prov-deepseek",
      },
      worker: {
        origin: "byok",
        model: "gpt-4o",
        provider_id: "prov-openai",
      },
      background: null,
      is_default: false,
    },
    {
      id: "prof-implicit",
      name: "隐式组合",
      kind: "implicit",
      main: { origin: "platform", model: "platform-flash", provider_id: null },
      worker: null,
      background: null,
      is_default: false,
    },
  ],
};

const CATALOG: ModelCatalog = {
  byok_configured: true,
  current: {
    id: "deepseek-v4-pro",
    origin: "byok",
    provider_id: "prov-deepseek",
  },
  models: [
    {
      id: "glm-5.2",
      origin: "platform",
      display_name: "GLM-5.2",
      vendor: "智谱 AI",
      capabilities: [],
      context_length: null,
      price: null,
      available: true,
    },
    {
      id: "platform-flash",
      origin: "platform",
      display_name: "Flash (平台)",
      vendor: "Platform",
      capabilities: [],
      context_length: null,
      price: null,
      available: true,
    },
    {
      id: "deepseek-v4-pro",
      origin: "byok",
      provider_id: "prov-deepseek",
      provider_label: "DeepSeek",
      display_name: "DeepSeek V4 Pro",
      vendor: "DeepSeek",
      capabilities: [],
      context_length: null,
      price: null,
      available: true,
    },
    {
      id: "gpt-4o",
      origin: "byok",
      provider_id: "prov-openai",
      provider_label: "OpenAI",
      display_name: "GPT-4o",
      vendor: "OpenAI",
      capabilities: [],
      context_length: null,
      price: null,
      available: true,
    },
  ],
};

let profilesData: LlmModelProfileListResponse = PROFILES;

vi.mock("@/api/modelProfiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/modelProfiles")>();
  return {
    ...actual,
    useModelProfiles: () => ({
      data: profilesData,
      loading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@/api/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/models")>();
  return {
    ...actual,
    useModels: () => ({
      data: CATALOG,
      loading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

const mockListProviders = vi.mocked(listLlmProviders);

function providersResponse(
  over: Partial<LlmProvidersResponse> = {},
): LlmProvidersResponse {
  return {
    providers: [],
    billing_mode: "byok",
    platform_available: false,
    platform_model: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  mockNavigate.mockReset();
});

beforeEach(() => {
  profilesData = PROFILES;
  mockListProviders.mockResolvedValue(providersResponse());
});

describe("ModelPicker (mobile profiles)", () => {
  it("lists combinations with 主 · Worker summary and hides implicit profiles", () => {
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("选择模型组合")).toBeTruthy();
    expect(screen.getByText("GLM-5.2")).toBeTruthy();
    expect(screen.getByText("写作强档")).toBeTruthy();
    expect(screen.getByText("GLM-5.2 · 跟随主模型")).toBeTruthy();
    expect(screen.getByText("DeepSeek V4 Pro · GPT-4o")).toBeTruthy();
    expect(screen.queryByText("隐式组合")).toBeNull();
    expect(screen.queryByText("跟随账号默认")).toBeNull();
  });

  it("marks system presets apart from user-built combinations", () => {
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const preset = screen.getByTestId(
      "profile-row-00000000-0000-4000-8000-000000000011",
    );
    expect(preset.textContent).toContain("预置");
    expect(
      screen.getByTestId("profile-row-prof-user-1").textContent,
    ).not.toContain("预置");
  });

  it("highlights the account default when no profile is selected yet", () => {
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("profile-row-00000000-0000-4000-8000-000000000011")
        .className,
    ).toContain("model-row-selected");
  });

  it("selects a concrete profile id", () => {
    const onSelect = vi.fn();
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("profile-row-prof-user-1"));
    expect(onSelect).toHaveBeenCalledWith("prof-user-1");
  });

  it("does not offer 跟随账号默认 even when a profile is already selected", () => {
    const onSelect = vi.fn();
    render(
      <ModelPicker
        conversationProfileId="prof-user-1"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("profile-row-prof-user-1").className).toContain(
      "model-row-selected",
    );
    expect(screen.queryByText("跟随账号默认")).toBeNull();
    expect(screen.queryByTestId("profile-row-follow-default")).toBeNull();
  });

  it("routes 管理组合 to 模型配置", () => {
    const onClose = vi.fn();
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("profile-manage"));
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(MODEL_CONFIG_PATH);
  });

  it("empty list with BYOK shows jiurelay and 去模型配置 CTA", async () => {
    profilesData = { default_model_profile_id: null, data: [] };
    mockListProviders.mockResolvedValue(providersResponse());
    const onClose = vi.fn();
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("profiles-empty")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("profiles-empty-byok")).toBeTruthy(),
    );
    const jiurelayLink = screen.getByRole("link", { name: "jiurelay" });
    expect(jiurelayLink.getAttribute("href")).toBe("https://jiurelay.com/");
    expect(screen.getByText(/免费自配额度/)).toBeTruthy();
    fireEvent.click(screen.getByText("去模型配置"));
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(MODEL_CONFIG_PATH);
  });

  it("empty list with platform_available shows retry/settings guide without jiurelay", async () => {
    profilesData = { default_model_profile_id: null, data: [] };
    mockListProviders.mockResolvedValue(
      providersResponse({
        platform_available: true,
        billing_mode: "platform",
      }),
    );
    render(
      <ModelPicker
        conversationProfileId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("profiles-empty-platform")).toBeTruthy(),
    );
    expect(screen.queryByRole("link", { name: "jiurelay" })).toBeNull();
    expect(screen.getByText(/请稍后重试/)).toBeTruthy();
    expect(screen.getByText(/到设置检查模型配置/)).toBeTruthy();
    expect(screen.getByText("去模型配置")).toBeTruthy();
  });
});
