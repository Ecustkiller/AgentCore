import { expect, test } from "@playwright/test";
import {
  ensureAuthed,
  expectHashConversation,
  openWebapp,
  scriptPrompt,
  sendPrompt,
  waitTurnSettled,
} from "../helpers/app";

/**
 * Case 6 — 团队浏览器壳：
 * - 活动卡：简化脚本 `browser_activity_card`（conformance display.kind=browser）
 *   → 聊天出现「浏览器 · N 步」；过程行不挂「打开浏览器」（入口是坞 tab / +）
 * - 登录 escalate：hot_gate `browser_login_escalate` →「需要你登录」→「打开浏览器」
 *
 * webapp e2e 无真 Electron browserApi——只钉壳 tab / CTA，不测 WebContents 导航。
 */
test.describe("浏览器活动卡 / 登录 escalate CTA", () => {
  test("浏览器活动卡：过程行无打开浏览器胶囊", async ({ page }) => {
    await openWebapp(page);
    await ensureAuthed(page);

    await sendPrompt(
      page,
      scriptPrompt("browser_activity_card", "请用浏览器调研目标站"),
    );
    await expectHashConversation(page);

    await waitTurnSettled(page);

    // 收场后工具组折叠成「Used N tools」——先展开再钉活动卡。
    const toolsSummary = page.getByRole("button", { name: /Used \d+ tools?/ });
    await expect(toolsSummary).toBeVisible({ timeout: 15_000 });
    await toolsSummary.click();

    await expect(
      page.getByRole("button", { name: /浏览器 · \d+ 步/ }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "打开浏览器" })).toHaveCount(
      0,
    );
  });

  test("登录 escalate：需要你登录 + 打开浏览器揭示右坞", async ({ page }) => {
    await openWebapp(page);
    await ensureAuthed(page);

    await page.getByRole("button", { name: "新对话" }).click();
    await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();

    await sendPrompt(
      page,
      scriptPrompt("browser_login_escalate", "需要登录才能继续"),
    );
    await expectHashConversation(page);

    await expect(page.getByText(/需要你登录/)).toBeVisible({
      timeout: 30_000,
    });

    // pending browserLogin 会自动 showBrowser；按钮仍作兜底，点一次钉 CTA。
    const openBrowser = page.getByRole("button", { name: "打开浏览器" });
    await expect(openBrowser).toBeVisible();
    await openBrowser.click();

    await expect(
      page.locator("aside").getByRole("button", { name: "浏览器", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
