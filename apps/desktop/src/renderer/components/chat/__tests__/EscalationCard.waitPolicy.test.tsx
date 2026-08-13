// @vitest-environment jsdom
/**
 * EscalationCard 等待口径薄切片（诚实性）：
 * - 默认部署（wire 无 timeout_seconds）：卡面说「一直等你」，不得承诺「未答则按此继续」
 * - 运维配了上限：照实写出上限
 * 两种部署各自的文案都必须与后端真实行为一致——卡面是用户判断「能不能先放着」的唯一依据。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import type { RunEscalation } from "@/stores/execution";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscalationCard } from "../EscalationCard";

const decideEscalation = vi.fn();

vi.mock("@/services/escalation", () => ({
  decideEscalation: (...args: unknown[]) => decideEscalation(...args),
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

afterEach(cleanup);

beforeEach(() => {
  decideEscalation.mockReset().mockResolvedValue("ok");
});

const pending: RunEscalation = {
  id: "esc-1",
  question: "数据库选 Postgres 还是 SQLite？",
  assumption: "暂按 Postgres 继续",
  blocking: true,
  status: "pending",
  answer: null,
  kind: "normal",
  questions: [],
};

function renderCard(esc: RunEscalation) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        {/* Spread `role` — prop is teammate display name, not ARIA role (biome a11y). */}
        <EscalationCard
          escalation={esc}
          {...{ role: "研究员" }}
          conversationId="conv-1"
          interactive
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("EscalationCard · 无超时部署（默认）", () => {
  it("tells the user nothing continues without them", () => {
    renderCard(pending);
    expect(
      screen.getByText(
        /不会自动继续——这条一直等你；点「按假设继续」才按此走：暂按 Postgres 继续/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/未答则按此继续/)).toBeNull();
  });

  it("does not promise CEO arbitration will fall back on its own", () => {
    renderCard({ ...pending, awaiting: "ceo" });
    expect(
      screen.getByText(
        /不会自动继续——等主管裁决；暂定假设：暂按 Postgres 继续/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/未裁则按此继续/)).toBeNull();
  });
});

describe("EscalationCard · 配了超时的部署", () => {
  it("shows the real ceiling on a user-answerable card", () => {
    renderCard({ ...pending, timeoutSeconds: 1800 });
    expect(
      screen.getByText(/30 分钟内未答则按此继续：暂按 Postgres 继续/),
    ).toBeTruthy();
    expect(screen.queryByText(/一直等你/)).toBeNull();
  });

  it("shows the real ceiling on a CEO arbitration card", () => {
    renderCard({ ...pending, awaiting: "ceo", timeoutSeconds: 7200 });
    expect(
      screen.getByText(/2 小时内未裁则按此继续：暂按 Postgres 继续/),
    ).toBeTruthy();
  });

  it("carries the ceiling into the browser-login card", () => {
    renderCard({ ...pending, browserLogin: true, timeoutSeconds: 900 });
    expect(screen.getByText(/需要你登录/)).toBeTruthy();
    expect(
      screen.getByText(/15 分钟内未答则按此继续：暂按 Postgres 继续/),
    ).toBeTruthy();
  });
});
