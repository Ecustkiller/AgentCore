import { describe, expect, it } from "vitest";
import {
  isSelfExplanatoryLookupError,
  toolGroupFaultLabel,
  toolRowFaultLabel,
} from "../toolFaultFace";

describe("toolRowFaultLabel", () => {
  it("is silent on success, running, and redirect", () => {
    expect(
      toolRowFaultLabel({ tool_name: "run", status: "success" }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({ tool_name: "run", status: "running" }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({
        tool_name: "code_execute",
        status: "redirect",
        failure: { code: "source_grep_redirect" },
      }),
    ).toBeNull();
  });

  it("labels exec tools 未通过, including parsed test failure with exit 0", () => {
    expect(
      toolRowFaultLabel({
        tool_name: "run",
        status: "error",
        display: { stdout: "1 failed", stderr: "", exit_code: 0 },
      }),
    ).toBe("未通过");
    expect(
      toolRowFaultLabel({
        tool_name: "code_execute",
        status: "error",
        display: { stdout: "", stderr: "boom", exit_code: 1 },
      }),
    ).toBe("未通过");
  });

  it("does not hang 未找到 or 未完成 on lookup / generic faults", () => {
    expect(
      toolRowFaultLabel({
        tool_name: "read",
        status: "error",
        failure: { code: "not_found" },
      }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({ tool_name: "edit", status: "error" }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({
        tool_name: "browser_click",
        status: "error",
        failure: { code: "NOT_FOUND" },
      }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({
        tool_name: "wait",
        status: "error",
        failure: { code: "WAIT_TIMEOUT" },
      }),
    ).toBeNull();
    expect(
      toolRowFaultLabel({
        tool_name: "browser_screenshot",
        status: "error",
        failure: { code: "no_frame" },
      }),
    ).toBeNull();
  });

  it("treats file lookup misses as skipping the extra sentence", () => {
    expect(
      isSelfExplanatoryLookupError({
        tool_name: "read",
        status: "error",
        failure: { code: "not_found" },
      }),
    ).toBe(true);
    expect(
      isSelfExplanatoryLookupError({
        tool_name: "edit",
        status: "error",
      }),
    ).toBe(true);
    expect(
      isSelfExplanatoryLookupError({
        tool_name: "browser_click",
        status: "error",
        failure: { code: "NOT_FOUND" },
      }),
    ).toBe(false);
  });

  it("stays silent on verify-incomplete (warning triangle, not a fault word)", () => {
    expect(
      toolRowFaultLabel({
        tool_name: "test_run",
        status: "error",
        display: {
          check: "typecheck",
          exit_code: -1,
          stdout: "",
          stderr: "idle",
          budget_exceeded: true,
        },
      }),
    ).toBeNull();
  });
});

describe("toolGroupFaultLabel", () => {
  it("is silent when every child succeeded", () => {
    expect(
      toolGroupFaultLabel([
        { tool_name: "read", status: "success" },
        { tool_name: "run", status: "success" },
      ]),
    ).toBeNull();
  });

  it("repeats 未通过 when any child is an exec failure", () => {
    expect(
      toolGroupFaultLabel([
        { tool_name: "read", status: "success" },
        { tool_name: "run", status: "error" },
      ]),
    ).toBe("未通过");
  });

  it("stays silent when kinds mix without an exec failure", () => {
    expect(
      toolGroupFaultLabel([
        { tool_name: "read", status: "error" },
        { tool_name: "wait", status: "error" },
      ]),
    ).toBeNull();
  });

  it("keeps 未通过 when an exec failure mixes with a lookup miss", () => {
    expect(
      toolGroupFaultLabel([
        { tool_name: "read", status: "error" },
        { tool_name: "run", status: "error" },
      ]),
    ).toBe("未通过");
  });
});
