import { afterEach, describe, expect, it } from "vitest";
import {
  beginLocalConversationStream,
  claimPrimaryStream,
  forceReleaseLocalConversationStream,
  hasLocalConversationStream,
  isPrimaryStreamIdle,
  onPrimaryStreamIdle,
  releasePrimaryStream,
  resetStreamOwnershipForTests,
  waitForPrimaryStreamIdle,
  whenLocalConversationStreamIdle,
} from "../turns/streamOwnership";

const CID = "conv-ownership";

afterEach(() => {
  resetStreamOwnershipForTests();
});

describe("streamOwnership — 主路所有权栈", () => {
  it("claim / release 嵌套：内层释放后仍忙，外层释放才 idle", async () => {
    const outer = claimPrimaryStream(CID);
    const inner = claimPrimaryStream(CID);
    expect(isPrimaryStreamIdle(CID)).toBe(false);
    releasePrimaryStream(CID, inner);
    expect(isPrimaryStreamIdle(CID)).toBe(false);
    const idle = waitForPrimaryStreamIdle(CID);
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    releasePrimaryStream(CID, outer);
    await idle;
    expect(isPrimaryStreamIdle(CID)).toBe(true);
    expect(resolved).toBe(true);
  });

  it("错 token / 重复 release 不误伤其它持有者", () => {
    const a = claimPrimaryStream(CID);
    releasePrimaryStream(CID, "not-a-token");
    expect(isPrimaryStreamIdle(CID)).toBe(false);
    releasePrimaryStream(CID, a);
    expect(isPrimaryStreamIdle(CID)).toBe(true);
    releasePrimaryStream(CID, a); // no-op
    expect(isPrimaryStreamIdle(CID)).toBe(true);
  });

  it("onPrimaryStreamIdle 在 release 时空栈时触发", () => {
    const hits: number[] = [];
    const t = claimPrimaryStream(CID);
    const unsub = onPrimaryStreamIdle(CID, () => hits.push(1));
    expect(hits).toEqual([]);
    releasePrimaryStream(CID, t);
    expect(hits).toEqual([1]);
    unsub();
  });
});

describe("streamOwnership — 本机流 leftover 放流", () => {
  it("forceRelease 清 leftover，后续 finally release 不把 count 打成负", () => {
    const release = beginLocalConversationStream(CID);
    expect(hasLocalConversationStream(CID)).toBe(true);
    expect(forceReleaseLocalConversationStream(CID)).toBe(true);
    expect(hasLocalConversationStream(CID)).toBe(false);
    release();
    expect(hasLocalConversationStream(CID)).toBe(false);
    expect(forceReleaseLocalConversationStream(CID)).toBe(false);
  });
});

describe("streamOwnership — 等本机流空闲", () => {
  it("已空闲则同步回调一次", () => {
    const hits: number[] = [];
    whenLocalConversationStreamIdle(CID, () => hits.push(1));
    expect(hits).toEqual([1]);
  });

  it("忙则等释放后再回调一次，取消后不再触发", () => {
    const release = beginLocalConversationStream(CID);
    const hits: number[] = [];
    const cancel = whenLocalConversationStreamIdle(CID, () => hits.push(1));
    expect(hits).toEqual([]);
    cancel();
    release();
    expect(hits).toEqual([]);

    const release2 = beginLocalConversationStream(CID);
    whenLocalConversationStreamIdle(CID, () => hits.push(2));
    expect(hits).toEqual([]);
    release2();
    expect(hits).toEqual([2]);
  });
});
