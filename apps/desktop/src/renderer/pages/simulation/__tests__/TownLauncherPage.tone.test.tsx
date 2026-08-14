// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/simulation/api", () => ({
  createSimulationRun: vi.fn(),
}));
vi.mock("@/simulation/runHistory", () => ({
  listSavedRuns: () => [],
  rememberRun: vi.fn(),
}));
vi.mock("@/simulation/OpenInAgentTownButton", () => ({
  OpenInAgentTownButton: ({
    onLaunchError,
  }: {
    onLaunchError?: (d: { message: string; candidates?: string[] }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onLaunchError?.({
          message: "找不到 AgentTown.exe",
          candidates: ["C:\\town\\AgentTown.exe"],
        })
      }
    >
      在 AgentTown 中打开
    </button>
  ),
}));

import { createSimulationRun } from "@/services/simulation/api";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { TownLauncherPage } from "../TownLauncherPage";

const create = vi.mocked(createSimulationRun);

function renderPage() {
  render(
    <MemoryRouter>
      <TownLauncherPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  create.mockReset();
  useSimulationUiStore.getState().resetSession();
});

afterEach(cleanup);

describe("TownLauncherPage · 可恢复失败", () => {
  it("创建失败 alert 走 muted，不涂 destructive", async () => {
    create.mockRejectedValue(new Error("小镇服务开小差"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "新建小镇" }));

    const alert = await screen.findByRole("alert");
    expect(alert.className).toContain("text-muted-foreground");
    expect(alert.className).not.toContain("destructive");
  });

  it("启动失败卡整卡用户提示走 noticeChipNeutral", () => {
    useSimulationUiStore.getState().setRun({
      id: "run-1",
      scenario: "town",
      tick: 0,
      hour: 0,
      status: "failed",
    });
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: "在 AgentTown 中打开" }),
    );

    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("找不到 AgentTown.exe");
    expect(card.className).toContain("bg-muted/40");
    expect(card.className).not.toContain("destructive");
  });
});
