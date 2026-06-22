/**
 * Throwaway Playwright/Electron UI smoke: launches the built desktop app and
 * drives the real renderer (welcome -> simple chat -> new conversation ->
 * multi-agent task card -> graph view -> final synthesis), saving screenshots.
 *
 * Requires the production build (out/) and a running backend on :8200.
 *   pnpm build && node e2e/ui-test.mjs
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, "..");
const shotsDir = join(appDir, "e2e-shots");
mkdirSync(shotsDir, { recursive: true });
const userDataDir = join(os.tmpdir(), `agentcore-e2e-${Date.now()}`);

async function shot(win, name) {
  await win.screenshot({ path: join(shotsDir, name) });
  console.log("SHOT", name);
}

/** Wait until a locator's text stops growing (streaming finished) or timeout. */
async function waitStable(win, locator, timeout) {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < timeout) {
    const len = (await locator.innerText().catch(() => "")).length;
    if (len > 0 && len === prev) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
    }
    prev = len;
    await win.waitForTimeout(1000);
  }
}

async function main() {
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
    cwd: appDir,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");

  const input = win.getByPlaceholder("输入消息…");
  await input.waitFor({ state: "visible", timeout: 30000 });
  await win.waitForTimeout(1200);
  await shot(win, "01-welcome.png");

  // Scenario 1: draft first send — creates conversation, navigates #/ → #/conversations/:id,
  // and must still stream the reply (regression: MessageInput unmount used to abort POST).
  const q1 = "用一句话介绍你自己，并用中文回答。";
  await input.fill(q1);
  await input.press("Enter");
  await win.getByText(q1).first().waitFor({ timeout: 15000 });
  await win.waitForURL(/#\/conversations\/[0-9a-f-]+/i, { timeout: 15000 });
  const md1 = win.locator(".markdown-body").last();
  await md1.waitFor({ timeout: 45000 });
  await waitStable(win, md1, 45000);
  await shot(win, "02-simple-chat.png");

  // New conversation via sidebar -> draft (validates switchConversation(null)).
  await win.getByTitle("新建对话").click();
  await win.waitForTimeout(1000);
  await shot(win, "03-new-conversation.png");

  // Scenario 3: multi-agent debate (validates new-conversation send + task card).
  const q2 = "微服务架构 vs 单体架构，哪个更好？请正反辩论后给出结论。";
  const input2 = win.getByPlaceholder("输入消息…");
  await input2.fill(q2);
  await input2.press("Enter");
  await win.getByText(q2).first().waitFor({ timeout: 15000 });

  try {
    const graphBtn = win.getByTitle("查看协作图");
    await graphBtn.waitFor({ timeout: 90000 });
    await win.waitForTimeout(2000);
    await shot(win, "04-multiagent-taskcard.png");

    await graphBtn.click();
    await win.locator(".react-flow__node").first().waitFor({ timeout: 15000 });
    await win.waitForTimeout(1800);
    await shot(win, "05-graph-view.png");

    await win.getByRole("button", { name: "返回" }).click();
    await win.waitForTimeout(800);
  } catch (e) {
    console.log("MULTIAGENT_UI_SKIPPED", String(e));
    await shot(win, "04-after-debate-send.png");
  }

  // Wait for the final synthesized answer to finish streaming.
  try {
    const mdLast = win.locator(".markdown-body").last();
    await mdLast.waitFor({ timeout: 160000 });
    await waitStable(win, mdLast, 160000);
    await shot(win, "06-multiagent-final.png");
  } catch (e) {
    console.log("FINAL_WAIT_SKIPPED", String(e));
    await shot(win, "06-final-fallback.png");
  }

  await app.close();
  console.log("DONE");
}

main().catch((e) => {
  console.error("E2E_FAIL", e);
  process.exit(1);
});
