import { Modal } from "@/components/Modal";
/**
 * Mobile pending-interaction chrome: Latch + Bottom Sheet.
 *
 * Dense gates (team_preview / plan_review / checkbox walls / stage) must not
 * inflate the chat column — body overscrolls inside a capped sheet; primary
 * CTAs stay pinned in the footer. Collapsing (backdrop / Esc / 收起) leaves a
 * short latch above the composer until the user resolves.
 */
import { type ReactNode, useState } from "react";

export function InteractionLatch({
  title,
  summary,
  onOpen,
  testId = "interaction-latch",
}: {
  title: string;
  summary?: string | null;
  onOpen: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="ix-latch"
      data-testid={testId}
      onClick={onOpen}
    >
      <div className="ix-latch-text">
        <div className="ix-latch-title">{title}</div>
        {summary ? <div className="ix-latch-summary">{summary}</div> : null}
      </div>
      <span className="ix-latch-action">查看</span>
    </button>
  );
}

export function InteractionSheet({
  title,
  label,
  onCollapse,
  footer,
  children,
  bodyAttrs,
}: {
  title: string;
  label?: string;
  onCollapse: () => void;
  footer: ReactNode;
  children: ReactNode;
  /** Extra attrs on the scroll body (e.g. data-ask-intent for tests). */
  bodyAttrs?: Record<string, string | undefined>;
}) {
  return (
    <Modal
      className="sheet interaction-sheet"
      onClose={onCollapse}
      label={label ?? title}
    >
      <div className="ix-sheet-head">
        <div className="ix-sheet-title">{title}</div>
        <button
          type="button"
          className="ix-sheet-collapse"
          onClick={onCollapse}
          aria-label="收起"
          data-testid="interaction-sheet-collapse"
        >
          收起
        </button>
      </div>
      <div className="ix-sheet-body" {...bodyAttrs}>
        {children}
      </div>
      <div className="ix-sheet-footer">{footer}</div>
    </Modal>
  );
}

/** Latch when collapsed; sheet auto-opens. Collapsing leaves only the latch. */
export function PendingInteractionChrome({
  title,
  summary,
  label,
  footer,
  children,
  initiallyOpen = true,
  bodyAttrs,
  latchTestId,
}: {
  title: string;
  summary?: string | null;
  label?: string;
  footer: ReactNode;
  children: ReactNode;
  initiallyOpen?: boolean;
  bodyAttrs?: Record<string, string | undefined>;
  latchTestId?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      {!open ? (
        <InteractionLatch
          title={title}
          summary={summary}
          onOpen={() => setOpen(true)}
          testId={latchTestId}
        />
      ) : null}
      {open ? (
        <InteractionSheet
          title={title}
          label={label}
          onCollapse={() => setOpen(false)}
          footer={footer}
          bodyAttrs={bodyAttrs}
        >
          {children}
        </InteractionSheet>
      ) : null}
    </>
  );
}
