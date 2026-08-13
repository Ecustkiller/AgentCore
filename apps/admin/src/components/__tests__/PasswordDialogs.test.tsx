// @vitest-environment jsdom
/**
 * The two admin-side password dialogs, now on the shared `Dialog`.
 *
 * 重置密码 shows a temp password the backend returns exactly once — there is no
 * re-fetch path — so the danger here is losing it to a stray click on the backdrop.
 * 设置密码 keeps its submit button in the dialog footer, outside the <form>, so the
 * `form=` association is what makes both Enter and the button take one path.
 */

import { ResetPasswordDialog } from "@/components/ResetPasswordDialog";
import { SetPasswordDialog } from "@/components/SetPasswordDialog";
import { resetUserPassword, setUserPassword } from "@/services/adminUsers";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/adminUsers", () => ({
  resetUserPassword: vi.fn(),
  setUserPassword: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function overlayOf(): Element {
  const overlay = screen.getByRole("dialog").previousElementSibling;
  if (!overlay) throw new Error("dialog overlay missing");
  return overlay;
}

describe("ResetPasswordDialog", () => {
  it("spells out the consequences before the destructive action", () => {
    render(
      <ResetPasswordDialog userId="u1" username="alice" onClose={vi.fn()} />,
    );
    expect(screen.getByText(/立即登出其所有设备/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /确认重置/ })).toBeTruthy();
  });

  it("closes on backdrop click while still only a confirmation", () => {
    const onClose = vi.fn();
    render(<ResetPasswordDialog userId="u1" username="alice" onClose={onClose} />);
    fireEvent.mouseDown(overlayOf());
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses to close on backdrop click once the one-time password is showing", async () => {
    const onClose = vi.fn();
    vi.mocked(resetUserPassword).mockResolvedValue({
      temporary_password: "Tmp-9f2a41",
    });
    render(<ResetPasswordDialog userId="u1" username="alice" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /确认重置/ }));
    expect(await screen.findByText("Tmp-9f2a41")).toBeTruthy();

    fireEvent.mouseDown(overlayOf());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Tmp-9f2a41")).toBeTruthy();

    // Escape still works: a modal that traps you is its own accessibility failure,
    // and pressing it is a deliberate act in a way that a misplaced click is not.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open and re-armed when the reset request fails", async () => {
    const onClose = vi.fn();
    vi.mocked(resetUserPassword).mockRejectedValue(new Error("boom"));
    render(<ResetPasswordDialog userId="u1" username="alice" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /确认重置/ }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /确认重置/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SetPasswordDialog", () => {
  it("submits from the footer button even though it sits outside the form", async () => {
    vi.mocked(setUserPassword).mockResolvedValue(undefined as never);
    render(<SetPasswordDialog userId="u1" username="alice" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/新密码（至少 8 位）/), {
      target: { value: "brand-new-pass" },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: "brand-new-pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /确认设置/ }));

    await waitFor(() =>
      expect(setUserPassword).toHaveBeenCalledWith("u1", {
        new_password: "brand-new-pass",
        force_change: true,
      }),
    );
  });

  it("keeps the submit disabled while the two entries disagree", () => {
    render(<SetPasswordDialog userId="u1" username="alice" onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/新密码（至少 8 位）/), {
      target: { value: "brand-new-pass" },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: "mismatch" },
    });

    expect(
      (screen.getByRole("button", { name: /确认设置/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("两次输入的密码不一致")).toBeTruthy();
    expect(setUserPassword).not.toHaveBeenCalled();
  });
});
