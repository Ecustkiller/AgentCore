/**
 * @vitest-environment jsdom
 *
 * SNAPSHOT_JS：placeholder / value 分列、disabled 标注、visible_text 尾部摘要。
 * 仓库无 Electron 主进程真跑设施；jsdom eval 是最轻量可证伪路径。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  WebContentsView: vi.fn(),
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../browser/workspace-protocol", () => ({
  registerWorkspaceProtocolFor: vi.fn(),
}));

let SNAPSHOT_JS: string;

beforeAll(async () => {
  ({ SNAPSHOT_JS } = await import("../browser/host"));
});

beforeEach(() => {
  // jsdom 默认 getBoundingClientRect 全 0，快照会跳过全部元素
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 24,
      right: 120,
      width: 120,
      height: 24,
      toJSON() {
        return {};
      },
    };
  };
});

function runSnapshot(html: string): string {
  document.documentElement.innerHTML = html;
  const fn = new Function(`return (${SNAPSHOT_JS})`)() as (
    version: number,
  ) => string;
  return fn(1);
}

describe("SNAPSHOT_JS form fields", () => {
  it("分列输出 placeholder 与 value，且 disabled 显式标注", () => {
    const out = runSnapshot(`
      <body>
        <main>
          <textarea
            aria-label="composer"
            placeholder="Type a message…"
          >hello draft</textarea>
          <button disabled>Send</button>
        </main>
      </body>
    `);
    expect(out).toMatch(/\[e\d+\] textarea: composer/);
    expect(out).toMatch(/placeholder="Type a message…"/);
    expect(out).toMatch(/value="hello draft"/);
    expect(out).toMatch(/\[e\d+\] button disabled: Send/);
    const textareaLine = out
      .split("\n")
      .find((l) => l.includes("textarea") && l.includes("composer"));
    expect(textareaLine).toBeTruthy();
    expect(textareaLine).toContain("placeholder=");
    expect(textareaLine).toContain("value=");
  });

  it("password 不回明文 value，仅掩码/长度", () => {
    const out = runSnapshot(`
      <body>
        <input type="password" aria-label="pwd" value="hunter2" placeholder="Password" />
      </body>
    `);
    expect(out).toContain("password");
    expect(out).not.toContain("hunter2");
    expect(out).toMatch(/value="\*\*\*"/);
    expect(out).toContain("chars=7");
  });

  it("可见非交互文本进 visible_text（尾部优先）", () => {
    const out = runSnapshot(`
      <body>
        <main>
          <div class="bubble">Alice: first message</div>
          <div class="bubble">Bob: second message visible</div>
          <button>Reply</button>
        </main>
      </body>
    `);
    expect(out).toContain("visible_text:");
    expect(out).toContain("Alice: first message");
    expect(out).toContain("Bob: second message visible");
    expect(out).toMatch(/\[e\d+\] button: Reply/);
  });
});
