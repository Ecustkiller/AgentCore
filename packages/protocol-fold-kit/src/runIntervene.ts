/**
 * 「只停这个人 / 只改这个人的方向」的可用性判定 —— 两端唯一判定源。
 *
 * 调用方**终局不画入口**（`!{@link isLiveRunStatus}` → 整条不渲染）。跑完 / 失败 / 取消 /
 * 跳过点不动也改不了，死按钮没有教学价值。排队未开工仍画：可停；改方向此时不可用，
 * 走下面的 `reason`，不要藏成「按钮不见了」。
 *
 * 与 {@link turnElapsedMs} / `teamGain` 同理放在 kit 里：桌面右坞 run 详情与手机队员
 * 详情说的必须是同一件事、同一句话。这类判定一旦两端各写一份，很快就会一端说
 * 「已经跑完」、另一端干脆不显示。
 */

/** 与 `ProjectedRun.status` / 桌面 `RunStatus` 同集合（宽松取 string，不引跨包类型）。 */
export type InterveneRunStatus = string;

export interface InterveneGate {
  enabled: boolean;
  /** 不可用原因（面向用户的一句话）；`enabled` 时为 null。 */
  reason: string | null;
}

const ENABLED: InterveneGate = { enabled: true, reason: null };

function blocked(reason: string): InterveneGate {
  return { enabled: false, reason };
}

/** 引擎还能作用于这个 run（在飞或排队中）——两个动作的共同前提。 */
export function isLiveRunStatus(status: InterveneRunStatus): boolean {
  return status === "running" || status === "pending";
}

const STOP_SETTLED: Record<string, string> = {
  completed: "这位队员已经跑完，没有可停的工作了。",
  failed: "这位队员已经结束（没跑成），没有可停的工作了。",
  cancelled: "这位队员已经停下了。",
  skipped: "这一步没有执行。",
};

const REDIRECT_SETTLED: Record<string, string> = {
  completed: "这位队员已经跑完，这一段改不动了——把新方向说给 CEO，他可以安排重做。",
  failed: "这位队员已经结束（没跑成），改不动了——把新方向说给 CEO，他可以安排重做。",
  cancelled: "这位队员已经停下，没有在跑的工作可以改。",
  skipped: "这一步没有执行，没有可改的工作。",
};

const STOP_SETTLED_FALLBACK = "这位队员已经结束了。";
const REDIRECT_SETTLED_FALLBACK = "这位队员已经结束，改不动了。";
const REDIRECT_NOT_STARTED =
  "这位队员还没开工，没有在跑的工作可以改；现在可以直接停掉他。";

/** 只停这一个队员（主 Agent 与对话继续，不是结束整轮）。 */
export function runStopGate(runStatus: InterveneRunStatus): InterveneGate {
  if (isLiveRunStatus(runStatus)) return ENABLED;
  return blocked(STOP_SETTLED[runStatus] ?? STOP_SETTLED_FALLBACK);
}

/**
 * 只改这一个队员的方向（取消在飞工作 → 带现场热续跑 / 同角色重做）。
 *
 * 这里**只做粗过滤**：run 已终局就没有在跑的工作可改，这一条本端看得见也不会看错。
 * 「引擎此刻还够不够得着他」不在这里判——那个问题本端答不了，点下去由服务端回答
 * （{@link InterveneAck}）。以前这里还看一个 `turnLive`（气泡还在流吗），团队转后台执行
 * 时它与「引擎够得着」分离：气泡收口了驱动循环照样能排干 redirect，于是画布说「可以改」、
 * 右坞说「这一轮已经结束了」，两边都在猜。
 *
 * 辩论幕不开放改方向属于**能力本就不存在**（见 `planCapabilities`），不是「来晚了」，
 * 由调用方直接不渲染该按钮——那种情况下没有「按钮消失」的错觉可言。
 */
export function runRedirectGate(runStatus: InterveneRunStatus): InterveneGate {
  if (!isLiveRunStatus(runStatus)) {
    return blocked(REDIRECT_SETTLED[runStatus] ?? REDIRECT_SETTLED_FALLBACK);
  }
  if (runStatus === "pending") return blocked(REDIRECT_NOT_STARTED);
  return ENABLED;
}

/**
 * 服务端对一次按人干预的回答（`run-stop` / `run-redirect` 响应体的结构子集）。
 *
 * `accepted=false` 表示**什么都没入队**：引擎要么已经不驱动这批工作了，要么当前计划里
 * 没有这个 run。此时不许显示「引擎将停下这位队员」——那正是这次改造要拆掉的假承诺。
 */
export interface InterveneAck {
  accepted: boolean;
  /** `queued` | `no_live_drive` | `unknown_run`；旧服务端可能不带。 */
  reason?: string | null;
  /** 面向用户的一句话，由服务端给出——三端照原样渲染，不各自编。 */
  detail?: string | null;
}

const ACK_ACCEPTED_FALLBACK = "已交给引擎。";
const ACK_REFUSED_FALLBACK = "引擎没有受理这次操作。";

/** 回执要显示的那句话：优先用服务端原话，缺了才用兜底句。 */
export function interveneAckText(ack: InterveneAck): string {
  const detail = (ack.detail ?? "").trim();
  if (detail) return detail;
  return ack.accepted ? ACK_ACCEPTED_FALLBACK : ACK_REFUSED_FALLBACK;
}
