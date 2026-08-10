// @vitest-environment jsdom
/**
 * Tests for the add / edit BYOK provider form. Covers the preset-prefilled create path and
 * the edit path where an omitted key keeps the stored ciphertext. The REST layer is mocked.
 * Connection-test model lives under 高级选项 (Input + datalist; still submitted as default_model).
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

/** Collect option values from the connection-test model datalist. */
function modelDatalistValues(): string[] {
  openAdvancedOptions();
  const input = screen.getByLabelText("连接测试用模型") as HTMLInputElement;
  const listId = input.getAttribute("list");
  expect(listId).toBeTruthy();
  if (!listId) throw new Error("expected datalist id");
  const list = document.getElementById(listId);
  expect(list).toBeInstanceOf(HTMLDataListElement);
  return Array.from((list as HTMLDataListElement).options).map((o) => o.value);
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

  it("exposes a free-text connection-test model with preset datalist", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);
    const modelInput = connectionTestModel() as HTMLInputElement;
    expect(modelInput.tagName).toBe("INPUT");
    expect(modelInput.value).toBe("deepseek-v4-flash");
    expect(modelDatalistValues()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(screen.queryByText("其他…")).toBeNull();

    fireEvent.change(modelInput, { target: { value: "deepseek-v4-pro" } });
    expect(modelInput.value).toBe("deepseek-v4-pro");
  });

  it("saves a hand-typed connection-test model without a 其他… step", async () => {
    mockCreate.mockResolvedValue({
      ...SAVED,
      default_model: "deepseek-custom",
    });
    const onSaved = vi.fn();
    render(<ProviderForm onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.change(connectionTestModel(), {
      target: { value: "deepseek-custom" },
    });
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
      (screen.getByLabelText("连接测试用模型") as HTMLInputElement).value,
    ).toBe("already-saved-custom");
  });

  it("prefills Moonshot and saves a listed model from the advanced input", async () => {
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
    const modelInput = connectionTestModel() as HTMLInputElement;
    expect(modelInput.value).toBe("kimi-k2.6");
    expect(modelDatalistValues()).toEqual([
      "kimi-k2.6",
      "kimi-k3",
      "kimi-k2.5",
    ]);

    fireEvent.change(modelInput, { target: { value: "kimi-k2.5" } });
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

  it("prefills JiuRelay endpoint, advanced model input, and key/model tip", () => {
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
    const modelInput = connectionTestModel() as HTMLInputElement;
    expect(modelInput.value).toBe("glm-5.2");
    expect(modelDatalistValues()).toEqual([
      "glm-5.2",
      "deepseek-v4-flash-0731",
      "grok-4.5",
    ]);
    openAdvancedOptions();
    expect(screen.getByText("领取的 Key 须与所选模型对应")).toBeTruthy();
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://jiurelay.com/openai/v1",
    );
  });

  it("applies the new preset default when the model was still the old default", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect((connectionTestModel() as HTMLInputElement).value).toBe(
      "deepseek-v4-flash",
    );
    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "jiurelay" },
    });

    expect((connectionTestModel() as HTMLInputElement).value).toBe("glm-5.2");
  });

  it("keeps a custom connection-test model when switching presets", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(connectionTestModel(), {
      target: { value: "my-hand-typed-model" },
    });
    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "jiurelay" },
    });

    expect((connectionTestModel() as HTMLInputElement).value).toBe(
      "my-hand-typed-model",
    );
  });

  it("keeps a non-default model listed on the next preset", () => {
    render(<ProviderForm onSaved={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "opencode_zen" },
    });
    fireEvent.change(connectionTestModel(), {
      target: { value: "kimi-k2.6" },
    });
    fireEvent.change(screen.getByLabelText("厂商"), {
      target: { value: "moonshot" },
    });

    expect((connectionTestModel() as HTMLInputElement).value).toBe("kimi-k2.6");
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
    expect(modelInput.getAttribute("list")).toBeNull();
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
