// @vitest-environment jsdom
/**
 * 本会话权限 sheet — 配方切换 + PUT permission-axes + 设为新会话默认。
 */
import {
  RECIPE_AXES,
  setConversationPermissionAxes,
  setUserDefaultRecipe,
} from "@/api/permissionAxes";
import { PermissionAxesSheet } from "@/components/PermissionAxesSheet";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/api/permissionAxes", async () => {
  const actual = await vi.importActual<typeof import("@/api/permissionAxes")>(
    "@/api/permissionAxes",
  );
  return {
    ...actual,
    setConversationPermissionAxes: vi.fn(),
    setUserDefaultRecipe: vi.fn(),
  };
});

const mockSetAxes = vi.mocked(setConversationPermissionAxes);
const mockSetDefault = vi.mocked(setUserDefaultRecipe);

afterEach(cleanup);
beforeEach(() => {
  mockSetAxes.mockReset();
  mockSetDefault.mockReset();
  mockSetAxes.mockResolvedValue(RECIPE_AXES.managed);
  mockSetDefault.mockResolvedValue("managed");
});

describe("PermissionAxesSheet", () => {
  it("PUTs when selecting a recipe on an existing conversation", async () => {
    const onAxesChange = vi.fn();
    render(
      <PermissionAxesSheet
        conversationId="c1"
        axes={RECIPE_AXES.less_interrupt}
        onAxesChange={onAxesChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /托管/ }));
    await waitFor(() =>
      expect(mockSetAxes).toHaveBeenCalledWith("c1", RECIPE_AXES.managed),
    );
    await waitFor(() =>
      expect(onAxesChange).toHaveBeenCalledWith(RECIPE_AXES.managed),
    );
  });

  it("applies locally on draft without calling PUT", async () => {
    const onAxesChange = vi.fn();
    render(
      <PermissionAxesSheet
        conversationId={null}
        axes={RECIPE_AXES.less_interrupt}
        onAxesChange={onAxesChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /托管/ }));
    await waitFor(() =>
      expect(onAxesChange).toHaveBeenCalledWith(RECIPE_AXES.managed),
    );
    expect(mockSetAxes).not.toHaveBeenCalled();
  });

  it("sets account default from built-in recipe", async () => {
    render(
      <PermissionAxesSheet
        conversationId="c1"
        axes={RECIPE_AXES.managed}
        onAxesChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("permission-set-default"));
    await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith("managed"));
    await waitFor(() =>
      expect(screen.getByTestId("permission-hint").textContent).toMatch(
        /新会话将默认「托管」/,
      ),
    );
  });
});
