/** Playwright UI helpers shared across capture commands. */

export async function dismissOnboarding(page) {
  const dialog = page.locator('[aria-label="欢迎使用 Nexus"]');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  const skip = dialog.getByRole("button", { name: /^跳过$/ });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  } else {
    const free = dialog.getByRole("button", { name: /先用免费额度/ });
    if (await free.isVisible().catch(() => false)) await free.click();
  }
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

export async function ensureDebateRoom(page) {
  const debateTab = page.getByRole("button", { name: /^辩论室$/ });
  if (await debateTab.isVisible().catch(() => false)) {
    await debateTab.click();
    await page.waitForTimeout(700);
    return true;
  }
  const open = page.getByRole("button", { name: /打开辩论室/ });
  if (await open.first().isVisible().catch(() => false)) {
    await open.first().click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

export async function ensureCollabGraph(page) {
  const graphTab = page.getByRole("button", { name: /^协作图$/ });
  if (await graphTab.isVisible().catch(() => false)) {
    await graphTab.click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

export async function expandDebateFullText(page) {
  const expand = page.getByRole("button", { name: /展开全文/ });
  const n = await expand.count();
  for (let j = 0; j < Math.min(n, 16); j++) {
    await expand.nth(j).click().catch(() => {});
  }
  if (n > 0) await page.waitForTimeout(400);
}

export async function hardReloadConversation(page, base, cid) {
  const home = new URL("index.webapp.html#/", base).href;
  const dest = new URL(`index.webapp.html#/conversations/${cid}`, base).href;
  await page.goto(home, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(500);
  await dismissOnboarding(page);
  await page.goto(dest, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await dismissOnboarding(page);
}

export async function landAfterSeek(page, base, cid) {
  await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  await dismissOnboarding(page);
  await ensureDebateRoom(page);
  await expandDebateFullText(page);
}

export async function loginIfNeeded(page, { user, pass }) {
  const userBox = page.getByPlaceholder("邮箱或用户名");
  const composer = page.getByPlaceholder(/输入消息/);
  await Promise.race([
    userBox.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
    composer.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
  ]);
  if (await userBox.isVisible().catch(() => false)) {
    await userBox.fill(user);
    await page.getByPlaceholder(/密码/).first().fill(pass);
    await page.locator('button[type="submit"]').click();
  }
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await dismissOnboarding(page);
  return { userBox, composer };
}

export async function captureProbe(page) {
  return page.evaluate(() => {
    const clone = document.body?.cloneNode(true);
    if (clone) {
      for (const sel of [
        "aside",
        "nav",
        "[data-sidebar]",
        '[class*="Sidebar"]',
        '[class*="sidebar"]',
      ]) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }
    const root = clone || document.body;
    const text = (root?.innerText ?? "").replace(/\s+/g, " ");
    const full = (document.body?.innerText ?? "").replace(/\s+/g, " ");
    return {
      text,
      snippet: text.slice(0, 900),
      streaming: /停止生成/.test(full),
      authorize: /授权开赛|授权并开工/.test(full),
      waitKickoff: /等待开工确认|开工卡/.test(full),
      debate:
        (/主持人/.test(text) && /立论|辩题|正方|反方/.test(text)) ||
        (/打开辩论室|辩论室/.test(full) && /第\s*\d+\s*轮/.test(text)),
      reactFlow: document.querySelectorAll(".react-flow").length,
      reactFlowNodes: document.querySelectorAll(".react-flow__node").length,
      hasDevBadge: /\bDEV\b/.test(document.body?.innerText?.slice(0, 400) ?? ""),
    };
  });
}

export async function waitUi(page, pred, { timeoutMs = 90_000, label = "ui" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await captureProbe(page);
    if (pred(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`timeout waiting ${label}; snippet=${last?.snippet?.slice(0, 160)}`);
}
