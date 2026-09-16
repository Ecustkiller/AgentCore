import { describe, expect, it } from "vitest";
import {
  MESSAGE_ACTION_REVEAL_CLASS,
  USER_MESSAGE_CHROME_OVERLAY_CLASS,
} from "../messageActionReveal";

describe("MESSAGE_ACTION_REVEAL_CLASS", () => {
  it("is visible below md and hover-gated from md up", () => {
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain("opacity-100");
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain("md:opacity-0");
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain("md:group-hover:opacity-100");
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain(
      "md:focus-within:opacity-100",
    );
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain("duration-fast");
    expect(MESSAGE_ACTION_REVEAL_CLASS).toContain(
      "motion-reduce:transition-none",
    );
  });
});

describe("user message chrome overlay", () => {
  it("sits in the list gap from md up instead of padding the following reply", () => {
    expect(USER_MESSAGE_CHROME_OVERLAY_CLASS).toContain("md:absolute");
    expect(USER_MESSAGE_CHROME_OVERLAY_CLASS).toContain("md:top-full");
    expect(USER_MESSAGE_CHROME_OVERLAY_CLASS).toContain("md:inset-x-0");
    expect(USER_MESSAGE_CHROME_OVERLAY_CLASS).toContain(
      "md:pointer-events-none",
    );
  });
});
