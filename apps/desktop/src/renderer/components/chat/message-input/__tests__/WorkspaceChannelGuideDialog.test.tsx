// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceChannelGuideDialog } from "../WorkspaceChannelGuideDialog";

afterEach(() => {
  cleanup();
});

const dialogText = () => screen.getByRole("dialog").textContent ?? "";

describe("WorkspaceChannelGuideDialog", () => {
  it("讲清文件在云上、不自动同步、要手动导出", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    expect(screen.getByText("在哪工作：怎么选")).toBeTruthy();
    expect(screen.getByText("文件放在云上")).toBeTruthy();
    expect(screen.queryByText("我的文件")).toBeNull();
    expect(screen.getByText(/看到的是同一份/)).toBeTruthy();
    expect(screen.getByText(/不会自动同步到你电脑/)).toBeTruthy();
    expect(dialogText()).toContain("导出 ZIP");
    expect(
      screen.getByText(/日常用、想在手机和网页接着看 → 上面四个/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
  });

  it("入口名与「在哪工作」菜单逐字一致", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    for (const label of [
      "快速对话",
      "新建文件夹",
      "从本机导入",
      "从 Git 克隆",
      "打开本机文件夹",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("导入说清是复制一份、原件不再跟着变", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    expect(screen.getByText(/复制一份上来/)).toBeTruthy();
    expect(screen.getByText(/原件不会跟着变/)).toBeTruthy();
  });

  it("本机文件夹直改本地，但明说不是离线模式", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    const local = screen.getByText(/不是离线模式/);
    expect(local.textContent).toMatch(/就是你电脑上的那个目录/);
    expect(local.textContent).toMatch(/联网/);
    expect(local.textContent).toMatch(/对话记录也仍然存在云上/);
  });

  it("只有云被标「推荐」，本机不并列推荐", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    expect(screen.getAllByText("推荐")).toHaveLength(1);
  });

  it("没有本机盘时只讲云", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional={false}
      />,
    );
    expect(screen.getByText("文件放在云上")).toBeTruthy();
    expect(screen.queryByText("我的文件")).toBeNull();
    expect(screen.getByText("推荐")).toBeTruthy();
    expect(screen.getByText(/不会自动同步到你电脑/)).toBeTruthy();
    expect(screen.queryByText("打开本机文件夹")).toBeNull();
    expect(dialogText()).not.toContain("离线模式");
  });

  // 防回潮：这份文案曾直接抄自内部设计文档，把实现词和防回潮对照写法漏给了用户。
  const BANNED = [
    "ModeControl",
    "Composer",
    "sidecar",
    "云桌",
    "过桥",
    "本机传统",
    "遗留",
    "后台云端",
    "通道",
    "合回",
    "≠",
  ];

  it.each([true, false])(
    "不出现代码符号与内部黑话（showLocalTraditional=%s）",
    (showLocalTraditional) => {
      render(
        <WorkspaceChannelGuideDialog
          open
          onOpenChange={() => {}}
          showLocalTraditional={showLocalTraditional}
        />,
      );
      const text = dialogText().toLowerCase();
      for (const word of BANNED) {
        expect(
          text.includes(word.toLowerCase()),
          `文案里不该出现「${word}」`,
        ).toBe(false);
      }
    },
  );
});
