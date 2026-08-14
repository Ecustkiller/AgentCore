// @vitest-environment jsdom
/**
 * 用量「将尽」走 primary（需要你留意），刷新失败条保持灰。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { type UsageSummary, getUsageSummary } from "@/services/usage";
import { useUsageStore } from "@/stores/usage";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/usage")>()),
  getUsageSummary: vi.fn(),
}));

import { UsageSettings } from "../UsageSettings";

const mockGet = vi.mocked(getUsageSummary);

function usageBd(input = 0, output = 0) {
  return { input, output, reasoning: 0, cache_hit: 0, cache_miss: 0 };
}

function costBd(total = 0) {
  return {
    input: 0,
    cached: 0,
    output: 0,
    total,
    currency: "CNY" as const,
    cny_total: 0,
    pricing_source: "curated" as const,
  };
}

function makeSummary(
  over: {
    monthCost?: number;
    monthLimit?: number;
    dayTokens?: number;
    dayTokenLimit?: number;
  } = {},
): UsageSummary {
  const monthCost = over.monthCost ?? 1_000_000_000;
  const monthLimit = over.monthLimit ?? 10_000_000_000;
  return {
    today: {
      usage: usageBd(over.dayTokens ?? 100, 0),
      cost: costBd(0),
      requests: 1,
    },
    month: {
      usage: usageBd(),
      cost: costBd(monthCost),
      requests: 1,
    },
    recent_daily_cost: [],
    quota: {
      daily_tokens: over.dayTokenLimit ?? 1_000_000,
      monthly_cost_nano: monthLimit,
      daily_cost_nano: 0,
      daily_requests: 200,
    },
    billing_mode: "platform",
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <UsageSettings />
    </TooltipProvider>,
  );
}

function monthMeterPct() {
  const label = screen.getByText("本月额度");
  return label.nextElementSibling;
}

function monthMeterFill() {
  const label = screen.getByText("本月额度");
  return label.parentElement?.nextElementSibling?.firstElementChild;
}

beforeEach(() => {
  mockGet.mockReset();
  useUsageStore.setState({
    summary: null,
    loading: false,
    error: null,
    messageCosts: {},
  });
});

afterEach(() => {
  cleanup();
});

describe("UsageSettings 将尽 tone", () => {
  it("near copy and meter use primary, not destructive", async () => {
    mockGet.mockResolvedValue(
      makeSummary({ monthCost: 8_000_000_000, monthLimit: 10_000_000_000 }),
    );
    renderPage();

    const hint = await screen.findByText(/接近本月额度/);
    expect(hint.className).toContain("text-primary");
    expect(hint.className).not.toContain("destructive");

    const pct = monthMeterPct();
    expect(pct?.textContent).toBe("80%");
    expect(pct?.className).toContain("text-primary");
    expect(pct?.className).not.toContain("destructive");

    const fill = monthMeterFill();
    expect(fill?.className).toContain("bg-primary");
    expect(fill?.className).not.toContain("destructive");
  });

  it("below the near threshold stays muted and hides 将尽 copy", async () => {
    mockGet.mockResolvedValue(
      makeSummary({ monthCost: 1_000_000_000, monthLimit: 10_000_000_000 }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("本月额度")).toBeTruthy());
    expect(screen.queryByText(/接近本月额度/)).toBeNull();

    const pct = monthMeterPct();
    expect(pct?.textContent).toBe("10%");
    expect(pct?.className).toContain("text-muted-foreground");
    expect(pct?.className).not.toContain("text-primary");
    expect(pct?.className).not.toContain("destructive");
  });

  it("refresh failure banner stays muted, not destructive", async () => {
    useUsageStore.setState({
      summary: makeSummary(),
      loading: false,
      error: null,
      messageCosts: {},
    });
    mockGet.mockRejectedValue(new Error("offline"));
    renderPage();

    const msg = await screen.findByText("用量加载失败，请重试");
    expect(msg.className).toContain("text-muted-foreground");
    expect(msg.className).not.toContain("destructive");
    expect(msg.parentElement?.className).toContain("bg-muted/40");
    expect(msg.parentElement?.className).not.toContain("destructive");
  });
});
