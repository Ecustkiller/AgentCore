/**
 * @vitest-environment jsdom
 *
 * 验收：带 placeholder 的 React 受控 textarea —— 旧路径（value= + Event）
 * 不触发 onChange；CDP Input.insertText 等价路径（原生 setter + input）
 * 会更新 React state，发送按钮从 disabled → enabled。
 *
 * 仓库 vitest 无真 Electron/Chromium；本文件证伪 React 根因，
 * CDP 接线由 browserHostInput.test.ts 覆盖。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { type FormEvent, act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

function Composer() {
  const [draft, setDraft] = useState("");
  const hasDraft = draft.trim().length > 0;
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
      }}
    >
      <textarea
        aria-label="composer"
        placeholder="Type a message…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="composer"
      />
      <button type="submit" disabled={!hasDraft}>
        Send
      </button>
    </form>
  );
}

/** 事故路径：直接赋 value + 普通 Event —— React _valueTracker 认为未变。 */
function brokenAssign(el: HTMLTextAreaElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * CDP Input.insertText 在 Chromium 中的等价效果：经原型 setter 写 DOM
 *（不经过 React 包装的 value setter），再派发 input —— onChange 触发。
 */
function cdpEquivalentInsertText(el: HTMLTextAreaElement, text: string): void {
  el.focus();
  el.select();
  const proto = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!proto) throw new Error("missing HTMLTextAreaElement value setter");
  proto.call(el, text);
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertText",
    }),
  );
}

describe("React controlled textarea type root-cause", () => {
  afterEach(() => cleanup());

  it("旧 value= 路径：发送按钮仍 disabled（根因复现）", () => {
    render(<Composer />);
    const ta = screen.getByTestId("composer") as HTMLTextAreaElement;
    const send = screen.getByRole("button", {
      name: "Send",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    brokenAssign(ta, "hello from agent");
    expect(send.disabled).toBe(true);
    expect(ta.getAttribute("placeholder")).toBe("Type a message…");
  });

  it("CDP 等价写入后 React state 更新，发送按钮 enabled", () => {
    render(<Composer />);
    const ta = screen.getByTestId("composer") as HTMLTextAreaElement;
    const send = screen.getByRole("button", {
      name: "Send",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    act(() => {
      cdpEquivalentInsertText(ta, "你好👋 draft");
    });
    expect(send.disabled).toBe(false);
    expect(ta.value).toBe("你好👋 draft");
  });
});
