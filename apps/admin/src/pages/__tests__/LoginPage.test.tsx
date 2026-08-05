// @vitest-environment jsdom

import { LoginPage } from "@/pages/LoginPage";
import { useAuthStore } from "@/stores/auth";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth", () => ({
  login: vi.fn(),
  loginMfa: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  useAuthStore.setState({
    status: "unauthenticated",
    user: null,
    pendingMfaToken: "pending-token",
    mfaSetupRequired: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginPage MFA", () => {
  it("caps TOTP input at 6 digits and enables submit only at length === 6", () => {
    render(<LoginPage />);

    const input = screen.getByPlaceholderText("验证码（6 位）") as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "验证并登录" }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "12345" } });
    expect(input.value).toBe("12345");
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "123456" } });
    expect(input.value).toBe("123456");
    expect(submit.disabled).toBe(false);

    fireEvent.change(input, { target: { value: "123456789" } });
    expect(input.value).toBe("123456");
    expect(submit.disabled).toBe(false);
  });
});
