// @vitest-environment jsdom
/**
 * Admin Go 窗口卡：无 Go 流量时诚实空态，有流量时才画 $12 / $30 / $60。
 * The leading block comment keeps the @vitest-environment directive file-leading.
 */

import { GoWindowsCard } from "@/components/GoWindowsCard";
import type { AdminGoWindow, AdminGoWindows } from "@/services/adminUsage";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

function emptyWindow(p?: Partial<AdminGoWindow>): AdminGoWindow {
  return {
    cost_total_nano: 0,
    estimated_usd_nano: 0,
    calls: 0,
    started_at: "2026-08-17T00:00:00Z",
    reset_at: "2026-08-24T00:00:00Z",
    ...p,
  };
}

function goWindows(p?: Partial<AdminGoWindows>): AdminGoWindows {
  return {
    as_of: "2026-08-18T12:00:00Z",
    cost_basis: "nominal_nano_cny",
    estimate_basis: "opencode_public_list",
    estimate_currency: "USD",
    estimate_price_as_of: "2026-08-18",
    estimate_model: "deepseek-v4-flash",
    subscription_day: 15,
    five_hour: emptyWindow({ started_at: null, reset_at: null }),
    weekly: emptyWindow(),
    monthly: emptyWindow({
      started_at: "2026-08-15T00:00:00Z",
      reset_at: "2026-09-15T00:00:00Z",
    }),
    members: [],
    ...p,
  };
}

describe("GoWindowsCard", () => {
  it("says 尚无 Go 流量 instead of $0 / $12 when no Go rows exist", () => {
    render(<GoWindowsCard data={goWindows()} error={null} onRetry={vi.fn()} />);
    expect(screen.getByText("尚无 Go 流量")).toBeTruthy();
    expect(screen.queryByText(/\/ \$12/)).toBeNull();
    expect(screen.queryByText("≈$0.00")).toBeNull();
    expect(screen.queryByText("5 小时窗")).toBeNull();
  });

  it("renders window caps when Go traffic is present", () => {
    render(
      <GoWindowsCard
        data={goWindows({
          five_hour: {
            cost_total_nano: 2_000_000_000,
            estimated_usd_nano: 1_230_000_000,
            calls: 4,
            started_at: "2026-08-18T10:00:00Z",
            reset_at: "2026-08-18T15:00:00Z",
          },
        })}
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("尚无 Go 流量")).toBeNull();
    expect(screen.getByText("5 小时窗")).toBeTruthy();
    expect(screen.getByText(/≈\$1\.23/)).toBeTruthy();
    expect(screen.getByText(/\/ \$12/)).toBeTruthy();
  });
});
