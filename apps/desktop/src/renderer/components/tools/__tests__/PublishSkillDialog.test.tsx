// @vitest-environment jsdom
import { PublishSkillDialog } from "@/components/tools/PublishSkillDialog";
import {
  PUBLISH_MISSING_INTRO,
  PUBLISH_READY_HINT,
} from "@/lib/skillStoreCopy";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("PublishSkillDialog", () => {
  it("缺介绍说明为什么拦，不上架", () => {
    const onConfirm = vi.fn();
    render(
      <PublishSkillDialog
        open
        busy={false}
        initialGroup={null}
        blockReason={PUBLISH_MISSING_INTRO}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText(PUBLISH_MISSING_INTRO)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "提示词分组" })).toBeNull();
    expect(screen.getByRole("button", { name: "上架" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("有介绍才选分组上架", () => {
    const onConfirm = vi.fn();
    render(
      <PublishSkillDialog
        open
        busy={false}
        initialGroup={null}
        blockReason={null}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText(PUBLISH_READY_HINT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "写作成稿" }));
    fireEvent.click(screen.getByRole("button", { name: "上架" }));
    expect(onConfirm).toHaveBeenCalledWith("writing");
  });
});
