// @vitest-environment jsdom
import { login } from "@/api/auth";
import { LoginPage } from "@/pages/LoginPage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/auth", () => ({
  login: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/lib/rememberedUsername", () => ({
  getRememberedUsername: () => null,
  setRememberedUsername: vi.fn(),
}));

afterEach(cleanup);

describe("LoginPage · form error line", () => {
  beforeEach(() => {
    vi.mocked(login).mockReset();
  });

  it("login failure is a generic .error line, not a needs-you bar", async () => {
    vi.mocked(login).mockRejectedValue(new Error("用户名或密码错误"));
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("用户名"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("用户名或密码错误")).toBeTruthy();
    const line = screen.getByText("用户名或密码错误").closest(".error");
    expect(line?.className).toBe("error");
    expect(line?.className).not.toMatch(/\b(bar|inline-actions|needs-you)\b/);
  });
});
