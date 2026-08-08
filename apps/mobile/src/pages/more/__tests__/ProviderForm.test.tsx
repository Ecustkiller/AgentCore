// @vitest-environment jsdom
/**
 * Tests for the add / edit BYOK provider form. Covers the preset-prefilled create path and
 * the edit path where an omitted key keeps the stored ciphertext. The REST layer is mocked.
 * Connection-test model lives under 高级选项 (still submitted as default_model).
 */
import type { LlmProviderView } from "@/api/llmProviders";
import { createLlmProvider, updateLlmProvider } from "@/api/llmProviders";
import { ProviderForm } from "@/pages/more/ProviderForm";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/llmProviders", () => ({
  createLlmProvider: vi.fn(),
  updateLlmProvider: vi.fn(),
}));

const mockCreate = vi.mocked(createLlmProvider);
const mockUpdate = vi.mocked(updateLlmProvider);

const SAVED: LlmProviderView = {
  id: "prov-1",
  label: "DeepSeek",
  base_url: "https://api.deepseek.com",
  default_model: "deepseek-v4-flash",
  status: "unchecked",
};

/** Open「高级选项」<details> so nested controls are queryable. */
function openAdvancedOptions(): HTMLDetailsElement {
  const details = screen.getByText("高级选项").closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("expected 高级选项 <details>");
  }
  details.open = true;
  return details;
}

/** Query「连接测试用模型」after opening advanced options. */
function connectionTestModel(): HTMLElement {
  openAdvancedOptions();
  return screen.getByLabelText("连接测试用模型");
}

afterEach(cleanup);
beforeEach(() => {
  mockCreate.mockReset();
  mockUpdate.mockReset();
});

describe("ProviderForm", () => {
  it("keeps connection-test model off the main path", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText("默认模型名")).toBeNull();
    expect(screen.getByText("厂商")).toBeTruthy();
    expect(screen.getByText("显示名称")).toBeTruthy();
    expect(screen.getByText(/^API Key/)).toBeTruthy();
    expect(screen.getByText("高级选项")).toBeTruthy();
    expect(
      screen.getByText(/选择后将预填名称与端点；日常选用请到「模型组合」/),
    ).toBeTruthy();
    expect(connectionTestModel()).toBeTruthy();
  });

  it("creates a provider from the default preset once a key is entered", async () => {
    mockCreate.mockResolvedValue(SAVED);
    const onSaved = vi.fn();
    render(<ProviderForm onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      api_key: "sk-test",
      base_url: "https://api.deepseek.com",
      default_model: "deepseek-v4-flash",
      label: "DeepSeek",
    });
    expect(onSaved).toHaveBeenCalledWith(SAVED);
  });

  it("requires a key before the add form can be saved", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits an existing provider, keeping the key when left blank", async () => {
    mockUpdate.mockResolvedValue({ ...SAVED, label: "My DeepSeek" });
    const onSaved = vi.fn();
    render(
      <ProviderForm
        provider={{ ...SAVED, label: "My DeepSeek" }}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    // The key field is optional in edit mode; save without touching it.
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, patch] = mockUpdate.mock.calls[0];
    expect(id).toBe("prov-1");
    expect(patch).not.toHaveProperty("api_key");
    expect(patch.label).toBe("My DeepSeek");
    expect(patch.default_model).toBe("deepseek-v4-flash");
  });

  it("exposes a preset model dropdown with 其他… under advanced", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);
    const modelSelect = connectionTestModel() as HTMLSelectElement;
    expect(modelSelect.tagName).toBe("SELECT");
    expect(modelSelect.value).toBe("deepseek-v4-flash");
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "__other__",
    ]);
    expect(screen.queryByLabelText("自定义连接测试用模型")).toBeNull();

    fireEvent.change(modelSelect, { target: { value: "deepseek-v4-pro" } });
    expect(modelSelect.value).toBe("deepseek-v4-pro");
  });

  it("shows a free-text field when 其他… is selected", async () => {
    mockCreate.mockResolvedValue({
      ...SAVED,
      default_model: "deepseek-custom",
    });
    const onSaved = vi.fn();
    render(<ProviderForm onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.change(connectionTestModel(), {
      target: { value: "__other__" },
    });
    openAdvancedOptions();
    const customInput = screen.getByLabelText(
      "自定义连接测试用模型",
    ) as HTMLInputElement;
    fireEvent.change(customInput, { target: { value: "deepseek-custom" } });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ default_model: "deepseek-custom" }),
    );
  });

  it("opens advanced when the stored model is not in the preset list", () => {
    render(
      <ProviderForm
        provider={{
          ...SAVED,
          default_model: "already-saved-custom",
        }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const details = screen.getByText("高级选项").closest("details");
    expect(details?.open).toBe(true);
    expect(
      (screen.getByLabelText("连接测试用模型") as HTMLSelectElement).value,
    ).toBe("__other__");
    expect(
      (screen.getByLabelText("自定义连接测试用模型") as HTMLInputElement).value,
    ).toBe("already-saved-custom");
  });

  it("prefills Moonshot and saves a listed model from the advanced dropdown", async () => {
    mockCreate.mockResolvedValue({
      id: "prov-moon",
      label: "Kimi (Moonshot)",
      base_url: "https://api.moonshot.cn/v1",
      default_model: "kimi-k2.5",
      status: "unchecked",
    });
    const onSaved = vi.fn();
    render(<ProviderForm onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "moonshot" },
    });
    const modelSelect = connectionTestModel() as HTMLSelectElement;
    expect(modelSelect.value).toBe("kimi-k2.6");
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([
      "kimi-k2.6",
      "kimi-k3",
      "kimi-k2.5",
      "__other__",
    ]);

    fireEvent.change(modelSelect, { target: { value: "kimi-k2.5" } });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-moon" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      api_key: "sk-moon",
      base_url: "https://api.moonshot.cn/v1",
      default_model: "kimi-k2.5",
      label: "Kimi (Moonshot)",
    });
  });

  it("prefills JiuRelay endpoint, advanced model dropdown, and key/model tip", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "jiurelay" },
    });

    expect((screen.getByLabelText("厂商") as HTMLSelectElement).value).toBe(
      "jiurelay",
    );
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe(
      "JiuRelay",
    );
    const modelSelect = connectionTestModel() as HTMLSelectElement;
    expect(modelSelect.value).toBe("glm-5.2");
    expect(Array.from(modelSelect.options).map((o) => o.value)).toEqual([
      "glm-5.2",
      "deepseek-v4-flash-0731",
      "grok-4.5",
      "__other__",
    ]);
    openAdvancedOptions();
    expect(screen.getByText("领取的 Key 须与所选模型对应")).toBeTruthy();
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://jiurelay.com/openai/v1",
    );
  });

  it("resets the connection-test model when switching presets", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(connectionTestModel(), {
      target: { value: "deepseek-v4-pro" },
    });
    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "jiurelay" },
    });

    expect((connectionTestModel() as HTMLSelectElement).value).toBe("glm-5.2");
    expect(screen.queryByLabelText("自定义连接测试用模型")).toBeNull();
  });

  it("keeps custom Base URL on main path; connection-test model in advanced", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "custom" },
    });

    expect(screen.getByLabelText("Base URL").tagName).toBe("INPUT");
    expect(screen.getByText("高级选项")).toBeTruthy();
    const modelInput = connectionTestModel() as HTMLInputElement;
    expect(modelInput.tagName).toBe("INPUT");
    fireEvent.change(modelInput, { target: { value: "my-custom-model" } });
    expect(modelInput.value).toBe("my-custom-model");
  });

  it("resolves jiurelay base URL when editing an existing provider", () => {
    render(
      <ProviderForm
        provider={{
          id: "prov-jiu",
          label: "JiuRelay",
          base_url: "https://jiurelay.com/openai/v1",
          default_model: "glm-5.2",
          status: "unchecked",
        }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("厂商") as HTMLSelectElement).value).toBe(
      "jiurelay",
    );
  });
});
