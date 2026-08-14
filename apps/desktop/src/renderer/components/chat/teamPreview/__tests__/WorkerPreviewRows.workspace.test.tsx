// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerPreviewRows } from "../WorkerPreviewRows";
import type { TeamPreviewWorkerView } from "../types";

afterEach(cleanup);

function worker(
  over: Partial<TeamPreviewWorkerView> &
    Pick<TeamPreviewWorkerView, "run_id" | "role">,
): TeamPreviewWorkerView {
  return {
    task: "",
    depends_on: [],
    ...over,
  };
}

describe("WorkerPreviewRows · workspace", () => {
  it("never paints workspace chrome when all desks match", () => {
    render(
      <WorkerPreviewRows
        workers={[
          worker({
            run_id: "r1",
            role: "调研",
            target_folder_name: "本会话工作区",
          }),
          worker({
            run_id: "r2",
            role: "撰写",
            target_folder_name: "本会话工作区",
          }),
        ]}
      />,
    );
    expect(screen.getByText("调研")).toBeTruthy();
    expect(screen.getByText("撰写")).toBeTruthy();
    expect(screen.queryByText(/工作区 ·/)).toBeNull();
  });

  it("never paints workspace chrome when desks differ", () => {
    render(
      <WorkerPreviewRows
        workers={[
          worker({
            run_id: "r1",
            role: "甲",
            target_folder_id: "f1",
            target_folder_name: "云端甲",
          }),
          worker({
            run_id: "r2",
            role: "乙",
            target_folder_id: "f2",
            target_folder_name: "云端乙",
          }),
        ]}
      />,
    );
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("乙")).toBeTruthy();
    expect(screen.queryByText(/工作区 ·/)).toBeNull();
  });

  it("hides workspace chrome on old frames without names", () => {
    render(
      <WorkerPreviewRows
        workers={[
          worker({ run_id: "r1", role: "调研", task: "读项目" }),
          worker({ run_id: "r2", role: "撰写", task: "写报告" }),
        ]}
      />,
    );
    expect(screen.queryByText(/工作区 ·/)).toBeNull();
  });
});
