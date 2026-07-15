import {
  type DraftEmptyInput,
  type OnboardingEligibilityInput,
  STARTER_TASK_CHIPS,
  hasModelAccess,
  hasSeenTip,
  markOnboardingSkipped,
  markTipSeen,
  resolveDraftEmptyKind,
  shouldShowOnboarding,
  shouldShowTip,
} from "@/lib/onboarding";
import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
} from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  __setUiStorageBackendForTests({
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => {
      memory.set(k, v);
    },
    removeItem: (k) => {
      memory.delete(k);
    },
    keys: () => [...memory.keys()],
  });
});

afterEach(() => {
  __setUiStorageBackendForTests(null);
  __clearMemoryUiStorageForTests();
});

describe("shouldShowOnboarding", () => {
  const base: OnboardingEligibilityInput = {
    hasModelAccess: false,
    conversationCount: 0,
    skipped: false,
  };

  it("shows for brand-new user with no key and no chats", () => {
    expect(shouldShowOnboarding(base)).toBe(true);
  });

  it("hides after skip", () => {
    expect(shouldShowOnboarding({ ...base, skipped: true })).toBe(false);
  });

  it("hides once a model is configured", () => {
    expect(shouldShowOnboarding({ ...base, hasModelAccess: true })).toBe(false);
  });

  it("hides once any conversation exists", () => {
    expect(shouldShowOnboarding({ ...base, conversationCount: 1 })).toBe(false);
  });

  it("still shows for free-tier users until skipped (connect CTA path)", () => {
    expect(
      shouldShowOnboarding({
        ...base,
        hasModelAccess: true,
        freeTierActive: true,
      }),
    ).toBe(true);
    expect(
      shouldShowOnboarding({
        ...base,
        hasModelAccess: true,
        freeTierActive: true,
        skipped: true,
      }),
    ).toBe(false);
  });
});

describe("resolveDraftEmptyKind", () => {
  const base: DraftEmptyInput = {
    hasModelAccess: false,
    conversationCount: 0,
  };

  it("needs_key when model is not connected", () => {
    expect(resolveDraftEmptyKind(base)).toBe("needs_key");
  });

  it("starter_chips when key is ready and still zero conversations", () => {
    expect(resolveDraftEmptyKind({ ...base, hasModelAccess: true })).toBe(
      "starter_chips",
    );
  });

  it("returning once the user has any conversation", () => {
    expect(
      resolveDraftEmptyKind({
        hasModelAccess: true,
        conversationCount: 3,
      }),
    ).toBe("returning");
  });

  it("needs_key even if conversations exist but key is gone", () => {
    expect(
      resolveDraftEmptyKind({
        hasModelAccess: false,
        conversationCount: 2,
      }),
    ).toBe("needs_key");
  });

  it("starter_chips when free tier grants model access (no BYOK key)", () => {
    expect(
      resolveDraftEmptyKind({
        hasModelAccess: hasModelAccess({
          configured: false,
          billing_mode: "byok",
          free_tier_active: true,
        }),
        conversationCount: 0,
      }),
    ).toBe("starter_chips");
  });
});

describe("hasModelAccess", () => {
  it("is true when BYOK configured", () => {
    expect(hasModelAccess({ configured: true })).toBe(true);
  });

  it("is true for platform billing mode", () => {
    expect(
      hasModelAccess({ configured: false, billing_mode: "platform" }),
    ).toBe(true);
  });

  it("is true when free tier is active without a key", () => {
    expect(
      hasModelAccess({
        configured: false,
        billing_mode: "byok",
        free_tier_active: true,
      }),
    ).toBe(true);
  });

  it("is false when unconfigured and free tier off", () => {
    expect(hasModelAccess({ configured: false, billing_mode: "byok" })).toBe(
      false,
    );
    expect(
      hasModelAccess({
        configured: false,
        billing_mode: "byok",
        free_tier_active: false,
      }),
    ).toBe(false);
    expect(hasModelAccess(null)).toBe(false);
  });
});

describe("starter chips", () => {
  it("ships exactly three Chinese multi-agent starter tasks", () => {
    expect(STARTER_TASK_CHIPS).toHaveLength(3);
    for (const chip of STARTER_TASK_CHIPS) {
      expect(chip.length).toBeGreaterThan(10);
      expect(/[\u4e00-\u9fff]/.test(chip)).toBe(true);
    }
  });
});

describe("contextual tip seen", () => {
  it("shows each tip only once until marked", () => {
    expect(shouldShowTip("inline_team_graph")).toBe(true);
    expect(hasSeenTip("inline_team_graph")).toBe(false);
    markTipSeen("inline_team_graph");
    expect(shouldShowTip("inline_team_graph")).toBe(false);
    expect(hasSeenTip("inline_team_graph")).toBe(true);
  });

  it("persists skip flag", () => {
    markOnboardingSkipped();
    expect(
      shouldShowOnboarding({
        hasModelAccess: false,
        conversationCount: 0,
        skipped: true,
      }),
    ).toBe(false);
  });
});
