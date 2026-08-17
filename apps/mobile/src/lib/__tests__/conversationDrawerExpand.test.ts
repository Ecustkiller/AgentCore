// @vitest-environment jsdom
import {
  CONVERSATION_DRAWER_EXPAND_KEY,
  isDrawerGroupExpanded,
  readDrawerGroupExpand,
  resetDrawerGroupExpandForTests,
  writeDrawerGroupExpand,
} from "@/lib/conversationDrawerExpand";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  resetDrawerGroupExpandForTests();
});

describe("isDrawerGroupExpanded", () => {
  it("无 persist 时默认展开（手机全展开，不是桌面只展开当前组）", () => {
    expect(
      isDrawerGroupExpanded({ stored: undefined, hasRequired: false }),
    ).toBe(true);
  });

  it("有 stored 用 stored：记住折叠", () => {
    expect(isDrawerGroupExpanded({ stored: false, hasRequired: false })).toBe(
      false,
    );
    expect(isDrawerGroupExpanded({ stored: true, hasRequired: false })).toBe(
      true,
    );
  });

  it("组内有「等你」时强制展开，盖过 persist 折叠", () => {
    expect(isDrawerGroupExpanded({ stored: false, hasRequired: true })).toBe(
      true,
    );
    expect(
      isDrawerGroupExpanded({ stored: undefined, hasRequired: true }),
    ).toBe(true);
  });
});

describe("conversationDrawerExpand persist", () => {
  it("记住折叠，等你盖过但不写回，等你消失后回到 persist", () => {
    writeDrawerGroupExpand("design", false);
    expect(readDrawerGroupExpand()).toEqual({ design: false });
    expect(localStorage.getItem(CONVERSATION_DRAWER_EXPAND_KEY)).toBe(
      JSON.stringify({ design: false }),
    );

    const stored = readDrawerGroupExpand().design;
    expect(isDrawerGroupExpanded({ stored, hasRequired: true })).toBe(true);
    // 等你强制展开本身不调用 write：persist 仍是折叠。
    expect(readDrawerGroupExpand()).toEqual({ design: false });

    expect(
      isDrawerGroupExpanded({
        stored: readDrawerGroupExpand().design,
        hasRequired: false,
      }),
    ).toBe(false);
  });

  it("按显示值写入展开，且各组互不影响", () => {
    writeDrawerGroupExpand("a", false);
    writeDrawerGroupExpand("b", true);
    expect(readDrawerGroupExpand()).toEqual({ a: false, b: true });
    expect(
      isDrawerGroupExpanded({
        stored: readDrawerGroupExpand().b,
        hasRequired: false,
      }),
    ).toBe(true);
  });

  it("reset 清掉 persist，缺键按默认展开", () => {
    writeDrawerGroupExpand("gone", false);
    resetDrawerGroupExpandForTests();
    expect(readDrawerGroupExpand()).toEqual({});
    expect(
      isDrawerGroupExpanded({
        stored: readDrawerGroupExpand().gone,
        hasRequired: false,
      }),
    ).toBe(true);
  });
});
