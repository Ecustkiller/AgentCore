// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import { fieldSurfaceClass } from "@/components/ui";
import { ApiError } from "@/services/api";
import { FeedbackSettings } from "../FeedbackSettings";

const item = {
  id: "fb-1",
  category: "bug",
  title: "上传附件后没有反应",
  description: "点提交后一直转圈",
  page_context: null,
  status: "open",
  admin_reply: null,
  created_at: "2026-07-01T03:00:00Z",
  updated_at: "2026-07-01T03:00:00Z",
};

function apiError(message: string): ApiError {
  return new ApiError(500, JSON.stringify({ error: { message } }));
}

beforeEach(() => {
  apiGet.mockResolvedValue({ data: [item], total: 1 });
  apiPost.mockResolvedValue(item);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "上传附件后没有反应" },
  });
  fireEvent.change(screen.getByLabelText("详细描述"), {
    target: { value: "点提交后一直转圈" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  });
}

describe("FeedbackSettings 表单", () => {
  it("分类 is the shared Select primitive, not a copied class string", async () => {
    render(<FeedbackSettings />);
    const select = screen.getByLabelText("分类");
    expect(select.tagName).toBe("SELECT");
    for (const token of fieldSurfaceClass.split(" ")) {
      expect(select.className).toContain(token);
    }
    expect(select.className).toContain("w-full");
    await screen.findByText(item.title);
  });

  it("announces the validation failure and never posts", async () => {
    render(<FeedbackSettings />);
    await screen.findByText(item.title);

    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "请填写标题和描述",
    );
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("submits the picked category and reports success politely", async () => {
    render(<FeedbackSettings />);
    await screen.findByText(item.title);

    fireEvent.change(screen.getByLabelText("分类"), {
      target: { value: "feature" },
    });
    await fillAndSubmit();

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith("/v1/feedback", {
        category: "feature",
        title: "上传附件后没有反应",
        description: "点提交后一直转圈",
        page_context: null,
      });
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("提交成功");
  });

  it("echoes the backend's reason when the submit is rejected", async () => {
    apiPost.mockRejectedValueOnce(apiError("标题过长，请精简后重试"));
    render(<FeedbackSettings />);
    await screen.findByText(item.title);

    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "标题过长，请精简后重试",
    );
  });
});

describe("FeedbackSettings 历史反馈", () => {
  it("shows the loading line, then the list", async () => {
    render(<FeedbackSettings />);
    expect(screen.getByText("加载中…")).toBeTruthy();
    expect(await screen.findByText(item.title)).toBeTruthy();
    expect(screen.getByText("待处理")).toBeTruthy();
  });

  it("shows the empty label when there is no history yet", async () => {
    apiGet.mockResolvedValue({ data: [], total: 0 });
    render(<FeedbackSettings />);
    expect(await screen.findByText("暂无反馈记录")).toBeTruthy();
  });

  it("keeps a failed load distinct from an empty one and retries", async () => {
    apiGet.mockRejectedValueOnce(apiError("服务暂时不可用"));
    render(<FeedbackSettings />);

    expect(await screen.findByText("服务暂时不可用")).toBeTruthy();
    expect(screen.queryByText("暂无反馈记录")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(item.title)).toBeTruthy();
  });
});
