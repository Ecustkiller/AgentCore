import { expect, test } from "@playwright/test";
import {
  ensureAuthed,
  expectHashConversation,
  openWebapp,
  scriptPrompt,
  waitTurnSettled,
} from "../helpers/app";

/**
 * Case 7 — 浏览器自动化输入的最后一公里：真 Chromium + 真受控 composer。
 *
 * 事故背景：`browser_type` 曾用 `el.value=` + 合成 input 事件，被 React
 * `_valueTracker` 吞掉 onChange，state 不更新 → 发送键始终 disabled → 点击空转，
 * 而工具照样回 ok。这里跑 `host.ts` 同一套 CDP 序列，钉住两件事：
 *   1. 旧路径必须仍然失败（否则本用例失去意义，等于没测）
 *   2. CDP Input.insertText 必须真的驱动 React state，并能把消息发出去
 */

const OLD_BROKEN_INJECT = (text: string) => `
  (() => {
    const el = document.querySelector('textarea');
    if (!el) throw new Error('composer_not_found');
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()
`;

test("CDP Input.insertText 驱动受控 composer 并真的发出消息", async ({
  page,
}) => {
  await openWebapp(page);
  await ensureAuthed(page);

  const composer = page.getByPlaceholder(/输入消息/);
  const send = page.getByRole("button", { name: "发送" });
  await expect(send).toBeDisabled();

  // -- 对照组：事故里的旧写法，DOM 有值但 React 不知道 ----------------------
  await page.evaluate(OLD_BROKEN_INJECT("旧路径注入的文字"));
  await expect(composer).toHaveValue("旧路径注入的文字");
  // 屏幕上有字（用户看到的），React state 仍为空（模型与发送键看到的）。
  await expect(send).toBeDisabled();

  // -- 实验组：host.ts 的 CDP 序列（focus + 全选 → Backspace → insertText）--
  const prompt = scriptPrompt("single_agent_text", "CDP 输入测试");
  const cdp = await page.context().newCDPSession(page);
  await composer.focus();
  await page.evaluate(() => {
    const el = document.querySelector("textarea");
    el?.select();
  });
  for (const type of ["keyDown", "keyUp"] as const) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
  }
  await cdp.send("Input.insertText", { text: prompt });

  // React state 真的更新了：受控 value 同步 + 发送键解禁。
  await expect(composer).toHaveValue(prompt);
  await expect(send).toBeEnabled();

  // 端到端：点发送，消息真的走出去并流回正文。
  await send.click();
  const convId = await expectHashConversation(page);
  expect(convId.length).toBeGreaterThan(8);
  await waitTurnSettled(page);
  await expect(page.getByText("你好，世界！")).toBeVisible({ timeout: 15_000 });
});
