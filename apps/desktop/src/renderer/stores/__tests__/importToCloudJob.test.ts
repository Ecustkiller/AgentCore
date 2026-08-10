import { useImportToCloudJobStore } from "@/stores/importToCloudJob";
import { beforeEach, describe, expect, it } from "vitest";

describe("importToCloudJob store", () => {
  beforeEach(() => {
    useImportToCloudJobStore.setState({
      running: false,
      controller: null,
    });
  });

  it("begin prevents a second concurrent job", () => {
    const a = new AbortController();
    const b = new AbortController();
    expect(useImportToCloudJobStore.getState().begin(a)).toBe(true);
    expect(useImportToCloudJobStore.getState().isRunning()).toBe(true);
    expect(useImportToCloudJobStore.getState().begin(b)).toBe(false);
  });

  it("cancel aborts the active controller", () => {
    const a = new AbortController();
    useImportToCloudJobStore.getState().begin(a);
    useImportToCloudJobStore.getState().cancel();
    expect(a.signal.aborted).toBe(true);
  });

  it("end ignores stale controllers", () => {
    const a = new AbortController();
    const b = new AbortController();
    useImportToCloudJobStore.getState().begin(a);
    useImportToCloudJobStore.getState().end(b);
    expect(useImportToCloudJobStore.getState().isRunning()).toBe(true);
    useImportToCloudJobStore.getState().end(a);
    expect(useImportToCloudJobStore.getState().isRunning()).toBe(false);
  });
});
