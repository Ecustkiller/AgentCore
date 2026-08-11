import { beforeEach, describe, expect, it } from "vitest";
import { useRecoveryDismissedStore } from "../recoveryDismissed";

describe("useRecoveryDismissedStore", () => {
  beforeEach(() => {
    useRecoveryDismissedStore.getState().reset();
  });

  it("latches dismissed message ids in session memory only", () => {
    expect(useRecoveryDismissedStore.getState().isDismissed("a1")).toBe(false);
    useRecoveryDismissedStore.getState().markDismissed("a1");
    expect(useRecoveryDismissedStore.getState().isDismissed("a1")).toBe(true);
    expect(useRecoveryDismissedStore.getState().dismissed.has("a1")).toBe(true);
    useRecoveryDismissedStore.getState().markDismissed("a1");
    expect([...useRecoveryDismissedStore.getState().dismissed]).toEqual(["a1"]);
    useRecoveryDismissedStore.getState().reset();
    expect(useRecoveryDismissedStore.getState().isDismissed("a1")).toBe(false);
  });
});
