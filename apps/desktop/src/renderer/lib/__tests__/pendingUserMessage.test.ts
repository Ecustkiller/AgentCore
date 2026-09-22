import {
  heldUserMessageIds,
  steerWaitingItems,
} from "@/lib/pendingUserMessage";
import { describe, expect, it } from "vitest";

const messages = [
  { id: "u0", role: "user", content: "先看登录" },
  { id: "a1", role: "assistant", content: "正在查" },
  { id: "u1", role: "user", content: "改看支付" },
  { id: "u2", role: "user", content: "再补一条" },
];

describe("heldUserMessageIds", () => {
  it("藏起仍在排队的用户行，以及尚未读取的插话行", () => {
    const hidden = heldUserMessageIds(["u2"], ["u1"]);
    expect([...hidden].sort()).toEqual(["u1", "u2"]);
  });

  it("没有排队 id、也没有未读插话 id 时不藏", () => {
    expect(heldUserMessageIds([], []).size).toBe(0);
  });
});

describe("steerWaitingItems", () => {
  it("received 且未进队的插话挂在等待条", () => {
    const items = steerWaitingItems(
      messages,
      (index) =>
        index === 1
          ? [
              {
                interjectionId: "ij-1",
                status: "received",
                content: "改看支付",
              },
              {
                interjectionId: "ij-q",
                status: "received",
                content: "已升队",
              },
            ]
          : undefined,
      new Set(["ij-q"]),
    );
    expect(items).toEqual([
      { interjectionId: "ij-1", content: "改看支付" },
    ]);
  });
});
