import { composerTrailingSlots } from "@/lib/composerTrailing";
import { describe, expect, it } from "vitest";

describe("composerTrailingSlots", () => {
  it("idle empty + voice → mic only", () => {
    expect(
      composerTrailingSlots({
        busy: false,
        hasDraft: false,
        voiceSupported: true,
        voiceActive: false,
      }),
    ).toEqual({ row: ["voice"], showQueueHint: false });
  });

  it("idle draft → send (hides mic)", () => {
    expect(
      composerTrailingSlots({
        busy: false,
        hasDraft: true,
        voiceSupported: true,
        voiceActive: false,
      }),
    ).toEqual({ row: ["send"], showQueueHint: false });
  });

  it("busy empty → stop only, no queue hint", () => {
    expect(
      composerTrailingSlots({
        busy: true,
        hasDraft: false,
        voiceSupported: true,
        voiceActive: false,
      }),
    ).toEqual({ row: ["stop"], showQueueHint: false });
  });

  it("busy draft → steer + stop + queue hint (no inline queue)", () => {
    expect(
      composerTrailingSlots({
        busy: true,
        hasDraft: true,
        voiceSupported: true,
        voiceActive: false,
      }),
    ).toEqual({ row: ["steer-send", "stop"], showQueueHint: true });
  });

  it("recording keeps voice slot even with draft", () => {
    expect(
      composerTrailingSlots({
        busy: false,
        hasDraft: true,
        voiceSupported: true,
        voiceActive: true,
      }),
    ).toEqual({ row: ["voice"], showQueueHint: false });
  });

  it("idle empty without voice → send slot", () => {
    expect(
      composerTrailingSlots({
        busy: false,
        hasDraft: false,
        voiceSupported: false,
        voiceActive: false,
      }),
    ).toEqual({ row: ["send"], showQueueHint: false });
  });
});
