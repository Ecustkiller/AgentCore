// @vitest-environment jsdom
/**
 * Continue 不得把预选 grant_* 退化成口头「已授权」——须先 picker + POST grant。
 */
import { AskDecisionBody } from "@/components/chat/ask/AskDecisionBody";
import type { AskUserContent } from "@/components/chat/ask/AskUserFields";
import { useAskAnswer } from "@/components/chat/ask/AskUserFields";
import { hasLocalFiles } from "@/lib/capabilities";
import {
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_REQUIRED_HINT,
} from "@/lib/desktopDownload";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pickAndGrantReadonlyFolder = vi.fn();
const pickAndGrantOrganizeFolder = vi.fn();

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: vi.fn(() => true),
}));

vi.mock("@/lib/grantReadonlyFolder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/grantReadonlyFolder")>();
  return {
    ...actual,
    pickAndGrantReadonlyFolder: (...args: unknown[]) =>
      pickAndGrantReadonlyFolder(...args),
  };
});

vi.mock("@/lib/grantOrganizeFolder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/grantOrganizeFolder")>();
  return {
    ...actual,
    pickAndGrantOrganizeFolder: (...args: unknown[]) =>
      pickAndGrantOrganizeFolder(...args),
  };
});

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/ManualHelpLink", () => ({
  MANUAL_HELP: { checkpoint: "/manual" },
  ManualHelpLink: () => null,
}));

const grantDefaultContent: AskUserContent = {
  question: "需要本机目录吗？",
  context: "",
  assumptions: [],
  questions: [
    {
      id: "q0",
      prompt: "授权",
      kind: "choice",
      options: [
        { label: "授权访问本机目录", action: "grant_readonly_folder" },
        { label: "继续用云端" },
      ],
      multiple: false,
      default: "授权访问本机目录",
    },
  ],
};

function Harness({
  content = grantDefaultContent,
  onContinue = vi.fn(),
  onBindResolve = vi.fn(async () => {}),
}: {
  content?: AskUserContent;
  onContinue?: () => void;
  onBindResolve?: (composed: string) => void | Promise<void>;
}) {
  const answer = useAskAnswer(content);
  return (
    <AskDecisionBody
      content={content}
      answer={answer}
      busy={false}
      submitting={null}
      onContinue={onContinue}
      onStop={() => {}}
      conversationId="conv-1"
      onBindResolve={onBindResolve}
    />
  );
}

describe("AskDecisionBody Continue + grant fulfillment", () => {
  beforeEach(() => {
    pickAndGrantReadonlyFolder.mockReset();
    pickAndGrantOrganizeFolder.mockReset();
    vi.mocked(hasLocalFiles).mockReturnValue(true);
    // canLocalFs 需要 fsApi；picker 本身已 mock，不必真实现。
    window.fsApi = {
      grantSessionReadonlyRoot: vi.fn(),
    } as unknown as typeof window.fsApi;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // biome-ignore lint/performance/noDelete: 测后清掉 stub，避免污染其它套件
    delete (window as { fsApi?: unknown }).fsApi;
  });

  it("preselected grant default + Continue opens picker (not bare onContinue)", async () => {
    const onContinue = vi.fn();
    const onBindResolve = vi.fn(async () => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: false,
      reason: "cancelled",
    });

    render(<Harness onContinue={onContinue} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    await waitFor(() => {
      expect(pickAndGrantReadonlyFolder).toHaveBeenCalledWith("conv-1");
    });
    expect(onContinue).not.toHaveBeenCalled();
    expect(onBindResolve).not.toHaveBeenCalled();
  });

  it("forwards well_known / target_name hints to grant helper", async () => {
    const onBindResolve = vi.fn(async () => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: false,
      reason: "cancelled",
    });
    const content: AskUserContent = {
      ...grantDefaultContent,
      questions: [
        {
          ...grantDefaultContent.questions[0],
          options: [
            {
              label: "授权桌面报表",
              action: "grant_readonly_folder",
              well_known: "desktop",
              target_name: "报表",
            },
          ],
          default: "授权桌面报表",
        },
      ],
    };
    render(<Harness content={content} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    await waitFor(() => {
      expect(pickAndGrantReadonlyFolder).toHaveBeenCalledWith("conv-1", {
        wellKnown: "desktop",
        targetName: "报表",
      });
    });
  });

  it("picker cancel stays on card — no resume / no bare grant copy", async () => {
    const onContinue = vi.fn();
    const onBindResolve = vi.fn(async () => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: false,
      reason: "cancelled",
    });

    render(<Harness onContinue={onContinue} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    await waitFor(() => {
      expect(pickAndGrantReadonlyFolder).toHaveBeenCalled();
    });
    expect(onContinue).not.toHaveBeenCalled();
    expect(onBindResolve).not.toHaveBeenCalled();
    // 卡仍在：主 CTA 仍可点
    expect(screen.getByRole("button", { name: /^提交$/ })).toBeTruthy();
  });

  it("picker success resumes via onBindResolve with fulfilled answer", async () => {
    const onContinue = vi.fn();
    const onBindResolve = vi.fn(async (_answer: string) => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: true,
      root: { id: "r1", name: "报表", alias: "报表" },
      alias: "报表",
      namespace: "external/报表",
    });

    render(<Harness onContinue={onContinue} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    await waitFor(() => {
      expect(onBindResolve).toHaveBeenCalled();
    });
    expect(onContinue).not.toHaveBeenCalled();
    const composed = onBindResolve.mock.calls[0]?.[0] ?? "";
    expect(composed).toContain("授权访问本机目录");
    expect(composed).toContain("报表");
    expect(composed).toContain("external/报表");
    expect(composed).toContain("只读");
  });

  it("picker success clears bindBusy so CTA is not stuck when card stays mounted", async () => {
    // resume 成功但不卸载卡（例如父级尚未换阶段）——主 CTA 不得永久 busy
    const onBindResolve = vi.fn(async () => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: true,
      root: { id: "r1", name: "报表", alias: "报表" },
      alias: "报表",
      namespace: "external/报表",
    });

    render(<Harness onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    await waitFor(() => {
      expect(onBindResolve).toHaveBeenCalled();
    });
    await waitFor(() => {
      const submit = screen.getByRole("button", { name: /^提交$/ });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("normal non-folder selection still uses onContinue", async () => {
    const onContinue = vi.fn();
    const onBindResolve = vi.fn(async () => {});
    render(<Harness onContinue={onContinue} onBindResolve={onBindResolve} />);
    // 改选普通选项（会清掉预选 grant）
    fireEvent.click(screen.getByRole("button", { name: /继续用云端/ }));
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    expect(pickAndGrantReadonlyFolder).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onBindResolve).not.toHaveBeenCalled();
  });

  it("option-row grant click still fulfills via picker", async () => {
    const onBindResolve = vi.fn(async () => {});
    pickAndGrantReadonlyFolder.mockResolvedValue({
      ok: true,
      root: { id: "r1", name: "资料", alias: "资料" },
      alias: "资料",
      namespace: "external/资料",
    });

    const content: AskUserContent = {
      ...grantDefaultContent,
      questions: [
        {
          ...grantDefaultContent.questions[0],
          default: "",
        },
      ],
    };
    render(<Harness content={content} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /授权访问本机目录/ }));

    await waitFor(() => {
      expect(pickAndGrantReadonlyFolder).toHaveBeenCalledWith("conv-1");
      expect(onBindResolve).toHaveBeenCalled();
    });
  });
});

describe("AskDecisionBody Continue + grant on Web", () => {
  beforeEach(async () => {
    const { hasLocalFiles } = await import("@/lib/capabilities");
    vi.mocked(hasLocalFiles).mockReturnValue(false);
    window.__WEB__ = true;
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.__WEB__ = undefined;
  });

  it("Continue with grant default shows download guide — no onContinue", () => {
    const onContinue = vi.fn();
    const onBindResolve = vi.fn(async () => {});
    render(<Harness onContinue={onContinue} onBindResolve={onBindResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));

    expect(onContinue).not.toHaveBeenCalled();
    expect(onBindResolve).not.toHaveBeenCalled();
    expect(pickAndGrantReadonlyFolder).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith(
      DESKTOP_DOWNLOAD_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.getByText(new RegExp(DESKTOP_REQUIRED_HINT))).toBeTruthy();
  });
});
