// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerBodyEditor } from "../ComposerBodyEditor";

const PLACEHOLDER = "说点什么…";

afterEach(() => {
  cleanup();
});

// 生产里 TurnComposer 是受控的（value 来自 state，onChange 回灌）。测试照抄这条回路，
// 否则「组合结束后占位符让位」根本观察不到。
function renderEditor() {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <ComposerBodyEditor
        value={value}
        attachments={[]}
        agentMentions={[]}
        placeholder={PLACEHOLDER}
        maxLength={32_000}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        onReconcile={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onRemoveAgent={vi.fn()}
        onCaret={vi.fn()}
        onKeyDown={vi.fn()}
        onPaste={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return { onChange, body: screen.getByTestId("composer-body") };
}

describe("ComposerBodyEditor IME composition", () => {
  it("hides the placeholder while the composition is open", () => {
    const { body } = renderEditor();
    expect(screen.queryByText(PLACEHOLDER)).not.toBeNull();

    fireEvent.compositionStart(body);

    // 回归点：组合中 value 仍为 ""，只判 value 的占位符会一直压在候选字底下（重叠）。
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it("keeps suppressing onChange until the composition ends", () => {
    const { onChange, body } = renderEditor();
    fireEvent.compositionStart(body);
    body.textContent = "ni";
    fireEvent.input(body);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(body);
    // 组合结束必须兜底吐出最终文本，否则首字会丢。
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("routes the composed text into value and keeps the placeholder out", () => {
    const { onChange, body } = renderEditor();
    fireEvent.compositionStart(body);
    body.textContent = "你好";
    fireEvent.compositionEnd(body);

    expect(onChange).toHaveBeenCalledWith("你好");
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it("brings the placeholder back when the composition ends on an empty draft", () => {
    const { body } = renderEditor();
    fireEvent.compositionStart(body);
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();

    fireEvent.compositionEnd(body);

    expect(screen.queryByText(PLACEHOLDER)).not.toBeNull();
  });

  it("still hides the placeholder for a plain keystroke", () => {
    const { body } = renderEditor();
    body.textContent = "a";
    fireEvent.input(body);
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });
});
