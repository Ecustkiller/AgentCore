// @vitest-environment jsdom
/**
 * 掌舵回执诚实性：引擎收下才说「已发送·下一轮生效」。
 *
 * 末轮边界一过（结辩 + 简报可达数十秒）引擎就停止接收掌舵——那期间点「够了，出结论」
 * 永不生效。旧行为不看返回值、一律回「已发送」，用户以为老板意志已下达。
 */

import type { Execution } from "@/stores/execution";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebateModel } from "../../model";
import { SteeringPanel } from "../SteeringPanel";

const submitDebateSteer = vi.fn();
vi.mock("@/services/debate", () => ({
  submitDebateSteer: (...args: unknown[]) => submitDebateSteer(...args),
}));

function model(): DebateModel {
  return { settled: false, rounds: [] } as unknown as DebateModel;
}

function execution(): Execution {
  return { id: "exec-1" } as unknown as Execution;
}

function clickConclude(accepted: boolean) {
  submitDebateSteer.mockReset();
  submitDebateSteer.mockResolvedValue(accepted);
  render(
    <SteeringPanel
      model={model()}
      execution={execution()}
      conversationId="conv-1"
      interactive
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /够了，出结论/ }));
}

afterEach(cleanup);

describe("SteeringPanel receipt", () => {
  it("says 已发送 only when the engine took the steer", async () => {
    clickConclude(true);
    await screen.findByText(/已发送·下一轮生效/);
    expect(screen.queryByText(/未生效/)).toBeNull();
  });

  it("says 未生效 when the engine has stopped accepting steers", async () => {
    clickConclude(false);
    const receipt = await screen.findByText(/未生效·辩论已停止接收掌舵/);
    expect(screen.queryByText(/已发送/)).toBeNull();
    expect(receipt.className).toContain("text-muted-foreground");
    expect(receipt.className).not.toContain("destructive");
  });
});
