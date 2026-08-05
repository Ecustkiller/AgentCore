// @vitest-environment jsdom
/**
 * Tests for BYOK ModelKeyForm — preset default_model is visible & editable.
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
import { ModelKeyForm } from "../ModelKeyForm";

const moonshot = getByokProviderPreset("moonshot");

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

beforeEach(() => {
  vi.mocked(createLlmProvider).mockReset();
  vi.mocked(updateLlmProvider).mockReset();
});

afterEach(cleanup);

describe("ModelKeyForm", () => {
  it("shows an editable default model for preset vendors (Moonshot)", async () => {
    vi.mocked(createLlmProvider).mockResolvedValue(savedProvider());
    const { onSaved } = renderForm();

    const presetSelect = screen.getByRole("combobox");
    fireEvent.change(presetSelect, { target: { value: "moonshot" } });

    const defaultModelInput = screen.getByLabelText("默认模型");
    expect(defaultModelInput).toBeTruthy();
    expect((defaultModelInput as HTMLInputElement).value).toBe(
      moonshot.defaultModel,
    );
    expect(
      screen.getByText(/连接测试与目录兜底用；日常选用请到「模型组合」/),
    ).toBeTruthy();

    fireEvent.change(defaultModelInput, {
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

  it("keeps the stored default model when editing a preset provider", async () => {
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

    const defaultModelInput = screen.getByLabelText(
      "默认模型",
    ) as HTMLInputElement;
    expect(defaultModelInput.value).toBe("already-saved-model");

    fireEvent.change(defaultModelInput, {
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
});
