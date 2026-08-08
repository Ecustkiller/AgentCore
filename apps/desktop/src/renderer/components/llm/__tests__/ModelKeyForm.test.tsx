// @vitest-environment jsdom
/**
 * Tests for BYOK ModelKeyForm — advanced「连接测试用模型」select +「其他…」escape.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { getByokProviderPreset } from "@/lib/byokProviderPresets";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/llmProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/llmProviders")>()),
  createLlmProvider: vi.fn(),
  updateLlmProvider: vi.fn(),
}));

import {
  type LlmProviderView,
  createLlmProvider,
  updateLlmProvider,
} from "@/services/llmProviders";
import { ModelKeyForm, OTHER_DEFAULT_MODEL_VALUE } from "../ModelKeyForm";

const moonshot = getByokProviderPreset("moonshot");
const deepseek = getByokProviderPreset("deepseek");
const jiurelay = getByokProviderPreset("jiurelay");

function savedProvider(over: Partial<LlmProviderView> = {}): LlmProviderView {
  return {
    id: "p-new",
    label: moonshot.label,
    base_url: moonshot.baseUrl,
    default_model: moonshot.defaultModel,
    status: "unchecked",
    masked_key: "••••abcd",
    ...over,
  };
}

function renderForm(props: Partial<ComponentProps<typeof ModelKeyForm>> = {}) {
  const onSaved = vi.fn();
  const result = render(
    <TooltipProvider>
      <ModelKeyForm onSaved={onSaved} {...props} />
    </TooltipProvider>,
  );
  return { ...result, onSaved };
}

function providerSelect(): HTMLSelectElement {
  return screen.getAllByRole("combobox")[0] as HTMLSelectElement;
}

/** Open「高级选项」<details> so nested controls become accessible to queries. */
function openAdvancedOptions(): HTMLDetailsElement {
  const details = screen.getByText("高级选项").closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("expected 高级选项 <details>");
  }
  details.open = true;
  return details;
}

/** Query「连接测试用模型」after opening advanced options. */
function defaultModelControl(): HTMLElement {
  openAdvancedOptions();
  return screen.getByLabelText("连接测试用模型");
}

beforeEach(() => {
  vi.mocked(createLlmProvider).mockReset();
  vi.mocked(updateLlmProvider).mockReset();
});

afterEach(cleanup);

describe("ModelKeyForm", () => {
  it("keeps default model off the main path; advanced holds 连接测试用模型", () => {
    renderForm();

    expect(screen.queryByText("默认模型")).toBeNull();
    expect(screen.getByText("厂商预设")).toBeTruthy();
    expect(screen.getByText("名称")).toBeTruthy();
    expect(screen.getByText(/^API Key/)).toBeTruthy();
    expect(screen.getByText("高级选项")).toBeTruthy();
    expect(
      screen.getByText(/选择后将预填名称与端点；日常选用请到「模型组合」/),
    ).toBeTruthy();
    expect(defaultModelControl()).toBeTruthy();
    expect(
      screen.getByText(/连接测试与目录兜底用；日常选用请到「模型组合」/),
    ).toBeTruthy();
  });

  it("shows DeepSeek preset models in a select including deepseek-v4-flash", () => {
    renderForm();

    fireEvent.change(providerSelect(), { target: { value: "deepseek" } });

    const modelSelect = defaultModelControl() as HTMLSelectElement;
    expect(modelSelect.tagName).toBe("SELECT");
    expect(modelSelect.value).toBe(deepseek.defaultModel);

    const optionValues = Array.from(modelSelect.options).map((o) => o.value);
    for (const model of deepseek.models) {
      expect(optionValues).toContain(model);
    }
    expect(optionValues).toContain(OTHER_DEFAULT_MODEL_VALUE);
    expect(screen.getByText("其他…")).toBeTruthy();
  });

  it("lets preset vendors pick「其他…」then free-type a custom default model", async () => {
    vi.mocked(createLlmProvider).mockResolvedValue(savedProvider());
    const { onSaved } = renderForm();

    fireEvent.change(providerSelect(), { target: { value: "moonshot" } });

    const modelSelect = defaultModelControl() as HTMLSelectElement;
    expect(modelSelect.value).toBe(moonshot.defaultModel);

    fireEvent.change(modelSelect, {
      target: { value: OTHER_DEFAULT_MODEL_VALUE },
    });
    const customInput = screen.getByLabelText(
      "自定义连接测试用模型",
    ) as HTMLInputElement;
    fireEvent.change(customInput, {
      target: { value: "kimi-custom-test" },
    });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(createLlmProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          label: moonshot.label,
          base_url: moonshot.baseUrl,
          default_model: "kimi-custom-test",
          api_key: "sk-test-key",
        }),
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("opens advanced when editing a stored model not in the preset list", async () => {
    vi.mocked(updateLlmProvider).mockResolvedValue(
      savedProvider({
        id: "p1",
        default_model: "already-saved-model",
      }),
    );
    renderForm({
      providerId: "p1",
      initialLabel: moonshot.label,
      initialBaseUrl: moonshot.baseUrl,
      initialModel: "already-saved-model",
    });

    const details = screen.getByText("高级选项").closest("details");
    expect(details?.open).toBe(true);
    expect(
      (screen.getByLabelText("连接测试用模型") as HTMLSelectElement).value,
    ).toBe(OTHER_DEFAULT_MODEL_VALUE);
    const customInput = screen.getByLabelText(
      "自定义连接测试用模型",
    ) as HTMLInputElement;
    expect(customInput.value).toBe("already-saved-model");

    fireEvent.change(customInput, {
      target: { value: "edited-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateLlmProvider).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          default_model: "edited-model",
          label: moonshot.label,
          base_url: moonshot.baseUrl,
        }),
      ),
    );
  });

  it("keeps custom provider Base URL on main path; connection-test model in advanced", () => {
    renderForm();
    fireEvent.change(providerSelect(), { target: { value: "custom" } });

    expect(screen.getByLabelText("Base URL").tagName).toBe("INPUT");
    expect(screen.getByText("高级选项")).toBeTruthy();

    const defaultModelInput = defaultModelControl() as HTMLInputElement;
    expect(defaultModelInput.tagName).toBe("INPUT");
    expect(screen.queryByText("其他…")).toBeNull();
  });

  it("shows JiuRelay key-model tip and all three models in the select", () => {
    renderForm();
    fireEvent.change(providerSelect(), { target: { value: "jiurelay" } });

    const modelSelect = defaultModelControl() as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((o) => o.value);
    for (const model of jiurelay.models) {
      expect(optionValues).toContain(model);
    }
    expect(modelSelect.value).toBe(jiurelay.defaultModel);
    expect(screen.getByText("领取的 Key 须与所选模型对应。")).toBeTruthy();
  });

  it("silently pre-fills default_model on preset change and still submits it", async () => {
    vi.mocked(createLlmProvider).mockResolvedValue(savedProvider());
    renderForm();

    fireEvent.change(providerSelect(), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "sk-test-key" },
    });
    // Main path must not expose「默认模型」; save without opening advanced.
    expect(screen.queryByText("默认模型")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(createLlmProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          label: deepseek.label,
          base_url: deepseek.baseUrl,
          default_model: deepseek.defaultModel,
          api_key: "sk-test-key",
        }),
      ),
    );
  });
});
