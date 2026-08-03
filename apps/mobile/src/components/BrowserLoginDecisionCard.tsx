/**
 * Mobile「需要你登录 / 已登录，继续」surface for:
 * - worker ``escalate(browser_login=true)`` (hot-path EscalationAnswer)
 * - CEO ``ask_user(browser_login=true)`` (cold-path ResumeCard)
 *
 * Semantic twin of desktop BrowserLoginDecisionCard — no right-dock shell on phone;
 * 「查看直播」opens {@link BrowserLiveSheet} (Sandbox cloud browser) when wired.
 */
export type BrowserLoginSubmitKind = "logged_in" | "use_assumption" | "stop";

export function BrowserLoginDecisionCard({
  roleLabel,
  question,
  assumption,
  busy,
  submitting,
  onLoggedIn,
  onUseAssumption,
  onStop,
  onOpenLive,
}: {
  roleLabel: string;
  question: string;
  assumption?: string;
  busy: boolean;
  submitting: BrowserLoginSubmitKind | null;
  onLoggedIn: () => void;
  onUseAssumption?: () => void;
  onStop?: () => void;
  /** Open BrowserLiveSheet (Sandbox). Absent → no「查看直播」affordance. */
  onOpenLive?: () => void;
}) {
  return (
    <div className="browser-login-card" data-testid="browser-login-decision">
      <div className="browser-login-title">{roleLabel} · 需要你登录</div>
      <p className="browser-login-hint">
        {onOpenLive
          ? "这是云端 Sandbox 浏览器。点「查看直播」在本机完成登录，然后点「已登录，继续」。"
          : "这是云端 Sandbox 浏览器。完成登录后点「已登录，继续」。"}
      </p>
      <p className="browser-login-question">{question}</p>
      {assumption ? (
        <p className="browser-login-assumption">未答则按此继续：{assumption}</p>
      ) : null}
      <div className="browser-login-actions">
        {onOpenLive ? (
          <button
            type="button"
            className="pause-btn pause-btn-neutral"
            disabled={busy}
            data-testid="browser-login-open-live"
            onClick={onOpenLive}
          >
            查看直播
          </button>
        ) : null}
        <button
          type="button"
          className="pause-btn pause-btn-primary"
          disabled={busy}
          onClick={onLoggedIn}
        >
          {submitting === "logged_in" ? "处理中…" : "已登录，继续"}
        </button>
        {onUseAssumption ? (
          <button
            type="button"
            className="pause-btn pause-btn-neutral"
            disabled={busy}
            onClick={onUseAssumption}
          >
            {submitting === "use_assumption" ? "处理中…" : "按假设继续"}
          </button>
        ) : null}
        {onStop ? (
          <button
            type="button"
            className="pause-btn pause-btn-danger"
            disabled={busy}
            onClick={onStop}
          >
            {submitting === "stop" ? "处理中…" : "停止"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
