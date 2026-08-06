// @vitest-environment jsdom
/**
 * Tests for BYOK ModelKeyForm — preset default_model select +「其他…」escape.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { getByokProviderPreset } from "@/lib/byokProviderPresets";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

function defaultModelSelect(): HTMLSelectElement {
  return screen.getAllByRole("combobox")[1] as HTMLSelectElement;
}

beforeEach(() => {
  vi.mocked(createLlmProvider).mockReset();
  vi.mocked(updateLlmProvider).mockReset();
});

afterEach(cleanup);

describe("ModelKeyForm", () => {
  it("shows DeepSeek preset models in a select including deepseek-v4-flash", () => {
    renderForm();

    fireEvent.change(providerSelect(), { target: { value: "deepseek" } });

    const modelSelect = defaultModelSelect();
    expect(modelSelect.tagName).toBe("SELECT");
    expect(modelSelect.value).toBe(deepseek.defaultModel);

    const optionValues = within(modelSelect)
      .getAllByRole("option")
      .map((opt) => (opt as HTMLOptionElement).value);
    for (const model of deepseek.models) {
      expect(optionValues).toContain(model);
    }
    expect(optionValues).toContain(OTHER_DEFAULT_MODEL_VALUE);
    expect(screen.getByText("其他…")).toBeTruthy();
    expect(
      screen.getByText(/连接测试与目录兜底用；日常选用请到「模型组合」/),
    ).toBeTruthy();
  });

  it("lets preset vendors pick「其他…」then free-type a custom default model", async () => {
    vi.mocked(createLlmProvider).mockResolvedValue(savedProvider());
    const { onSaved } = renderForm();

    fireEvent.change(providerSelect(), { target: { value: "moonshot" } });

    const modelSelect = defaultModelSelect();
    expect(modelSelect.value).toBe(moonshot.defaultModel);

    fireEvent.change(modelSelect, {
      target: { value: OTHER_DEFAULT_MODEL_VALUE },
    });
    const customInput = screen.getByLabelText(
      "自定义默认模型",
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

  it("opens「其他…」when editing a stored model not in the preset list", async () => {
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

    expect(defaultModelSelect().value).toBe(OTHER_DEFAULT_MODEL_VALUE);
    const customInput = screen.getByLabelText(
      "自定义默认模型",
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

  it("keeps custom provider on free-text default model without a select", () => {
    renderForm();
    fireEvent.change(providerSelect(), { target: { value: "custom" } });

    const defaultModelInput = screen.getByLabelText(
      "默认模型",
    ) as HTMLInputElement;
    expect(defaultModelInput.tagName).toBe("INPUT");
    expect(screen.queryByText("其他…")).toBeNull();
  });

  it("shows JiuRelay key-model tip and all three models in the select", () => {
    renderForm();
    fireEvent.change(providerSelect(), { target: { value: "jiurelay" } });

    const modelSelect = defaultModelSelect();
    const optionValues = within(modelSelect)
      .getAllByRole("option")
      .map((opt) => (opt as HTMLOptionElement).value);
    for (const model of jiurelay.models) {
      expect(optionValues).toContain(model);
    }
    expect(modelSelect.value).toBe(jiurelay.defaultModel);
    expect(screen.getByText("领取的 Key 须与所选模型对应。")).toBeTruthy();
  });
});
