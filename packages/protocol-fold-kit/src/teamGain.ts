/**
 * 回合「协作收益」口径 —— 找一支团队干活换来了什么，只说已经真实发生的事实。
 *
 * 两条口径都从**现成数据换个说法**得来，零新增评价：`parallelSaving` 只做两个已有时长的
 * 减法，`formatCollabSummary` 只给 `message_end.collab` 的四个计数换用户读得懂的说法。
 * 这里绝不生成「本次协作价值总结」之类的评语——刚修完一整批「呈现与真相不符」，再加一个
 * 会吹牛的评价器是自相矛盾。没有可说的就返回 null，调用方保持沉默。
 *
 * 与 {@link turnElapsedMs} 同理放在 kit 里：它们是**同名指标 + 同一句文案**，桌面与手机
 * 必须说同一件事、同一个数。「用时」曾在两端分叉（手机把工时当用时，同一回合桌面 40s /
 * 手机 2m10s），这里从源头上不给分叉留缝——数字与句子都只有一处定义。数字格式化仍由各端
 * 传入自己的 `formatMs`（两端实现逐字相同），kit 不重复一份时长格式化。
 */

// ── 一、并行省了多少时间 ───────────────────────────────────────────────

/**
 * 桌面 `Execution.runs` 与手机 `ProjectedRun` 都满足的结构子集。
 *
 * `id` / `parentRunId` / `continuesRunId` 可省：缺了就退化成「一层扁平、每个 run 各算一人」，
 * 也就是加入嵌套与接续折叠之前的老口径。
 */
export interface WorkerDurationRun {
  id?: string | null;
  kind: string;
  durationMs?: number | null;
  /** 委派父 run；父是队员（不是 captain）时，这段活的时长被父包在里面。 */
  parentRunId?: string | null;
  /** 同人接续（续派 / 热修）的现场根 run id——同根的多个 run 是同一位队员。 */
  continuesRunId?: string | null;
}

export interface ParallelSaving {
  /** 串行工时 − 实际墙钟跨度：并行真正省下的那段。 */
  savedMs: number;
  /** 各队员时长之和 = 这些活一个接一个做要多久（工时，不是用时）。 */
  serialMs: number;
  /** 回合墙钟跨度 = 用户实际等了多久（{@link turnElapsedMs} / 桌面 `elapsedMs(frames)`）。 */
  elapsedMs: number;
  /** 参与比较的**人**数（同一位队员的多轮接续算一位，不是 run 数）。 */
  workers: number;
}

/**
 * 低于这个差值不说「省下」：`formatDuration` 按秒取整，几百毫秒的差会渲染成「省下 0s」，
 * 那是噪声不是收益。
 */
export const PARALLEL_SAVING_MIN_MS = 1_000;

function positiveMs(run: WorkerDurationRun): number {
  const ms = run.durationMs;
  return typeof ms === "number" && ms > 0 ? ms : 0;
}

/** 有真实时长的队员 run（captain 不计——它是对话本身，不是被派出去的活）。 */
function timedWorkerRuns(
  runs: readonly WorkerDurationRun[],
): WorkerDurationRun[] {
  return runs.filter((r) => r.kind !== "captain" && positiveMs(r) > 0);
}

/**
 * 各队员时长之和（captain 不计——它是对话本身，不是被派出去的活）。
 *
 * 这是**工时**：并行度越高它越大。绝不能拿它顶替「用时」（手机曾这么干，把并行省时显示成了
 * 更慢），它在这里只有一个用途——当「这些活一个接一个做要多久」的对比基准。
 *
 * 嵌套子团队要扣重叠：lead 的时长**包着**它子队员的时长（lead 在等他们的那段时间里，两边
 * 的秒表同时在走）。直接相加等于把同一段时间数两遍，`savedMs` 随之虚高——而这个函数对外
 * 承诺自己是不会夸大的下界。所以每个 run 只贡献「自己那段活」= 本人时长减去子队员时长；
 * 子队员之间若是并行，减完为负按 0 计，此时总数就等于子队员工时之和（他们一个接一个做
 * 确实要那么久，lead 在旁边看着不额外算工）。
 */
export function serialWorkMs(runs: readonly WorkerDurationRun[]): number {
  const childMs = new Map<string, number>();
  for (const run of timedWorkerRuns(runs)) {
    const parent = run.parentRunId;
    if (!parent) continue;
    childMs.set(parent, (childMs.get(parent) ?? 0) + positiveMs(run));
  }
  let total = 0;
  for (const run of timedWorkerRuns(runs)) {
    const own = positiveMs(run) - (run.id ? (childMs.get(run.id) ?? 0) : 0);
    if (own > 0) total += own;
  }
  return total;
}

/**
 * 这一批 run 出自几**位**队员——同一个人的多轮接续（续派 / 热修）算一位。
 *
 * 接续 run 在图上是独立节点、还各带一个新 `agentId`（身份从现场根继承），按 run 数或按
 * agent 数都会把「张三改了三版」数成三位队员。同人链共享 `continuesRunId`（现场根 id），
 * 折到根上才是人数。缺字段的旧数据退回按 run 计。
 */
function participantCount(runs: readonly WorkerDurationRun[]): number {
  const people = new Set<string>();
  let anonymous = 0;
  for (const run of timedWorkerRuns(runs)) {
    const root = run.continuesRunId || run.id;
    if (root) people.add(root);
    else anonymous += 1;
  }
  return people.size + anonymous;
}

/**
 * 本回合并行省下的时间；没有可说的就返回 null（调用方沉默）。
 *
 * 三种沉默：只有一位队员（一个人改几版不叫并行）、没有跨度可比、串行工时并不比实际用时长
 * （并行没产生任何节省——常见于队员接力跑，或 CEO 自身思考占了大头）。
 *
 * **诚实边界（硬约束）**：`serialMs` 是「同一批活一个接一个做要多久」，**不是**「单个 AI 做
 * 同一件事要多久」——后者我们没有任何数据（单 AI 可能更快，没有协调开销；也可能更慢，上下文
 * 塌陷）。文案不得宣称或暗示后者。另外本函数刻意保守：CEO 拆解 / 汇总的时间算进了 `elapsedMs`
 * 却不算进 `serialMs`，嵌套子团队里 lead 与子队员重叠的那段也只算一次，所以真实的串行回合
 * 只会更长——报出来的 `savedMs` 是下界，不会夸大。
 */
export function parallelSaving(args: {
  elapsedMs: number;
  runs: readonly WorkerDurationRun[];
}): ParallelSaving | null {
  const { elapsedMs, runs } = args;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const workers = participantCount(runs);
  if (workers < 2) return null;
  const serialMs = serialWorkMs(runs);
  const savedMs = serialMs - elapsedMs;
  if (savedMs < PARALLEL_SAVING_MIN_MS) return null;
  return { savedMs, serialMs, elapsedMs, workers };
}

/** 状态条上的一段（紧跟「用时」）：并行换来的那段时间。 */
export function parallelSavingText(
  saving: ParallelSaving,
  formatMs: (ms: number) => string,
): string {
  return `同时开工省下 ${formatMs(saving.savedMs)}`;
}

/**
 * 解释这个对比是什么、以及**不是**什么。末句是诚实边界的落点：把基准钉死在「同一批活串行 vs
 * 并行」，任何把它改写成「比单个 AI 快」的改动都会让 teamGain.test.ts 的诚实边界用例变红。
 */
export function parallelSavingTooltip(
  saving: ParallelSaving,
  formatMs: (ms: number) => string,
): string {
  return (
    `${saving.workers} 位队员的活加起来 ${formatMs(saving.serialMs)}——` +
    `一个接一个做要这么久；他们同时开工，你只等了 ${formatMs(saving.elapsedMs)}。` +
    `对比的是同一批活「一个接一个」和「同时开工」，不是拿一个 AI 做同一件事来比。`
  );
}

// ── 二、队友互相挑出了几处 ─────────────────────────────────────────────

/**
 * `message_end.collab` / `MessageDetail.collab` 的结构子集（kit 不依赖事件契约包）。
 *
 * `*_by_user` 是同名计数里**用户亲手促成**的那一份（服务端按「谁做的」分出来的子集，
 * 不是另一批事件）。运营口径读的仍是总数，这里只在用户面把它减掉。
 */
export interface CollabCounts {
  boundary_yields?: number | null;
  /** `boundary_yields` 中用户在计划复核里拍板造成的那份。 */
  boundary_yields_by_user?: number | null;
  scope_signals?: number | null;
  revises?: number | null;
  /** `revises` 中用户点「立即改此人」促成的那份。 */
  revises_by_user?: number | null;
  escalations?: number | null;
}

function count(n: number | null | undefined): number {
  return typeof n === "number" && n > 0 ? n : 0;
}

/** 总数减掉用户自己促成的那份，且不会因数据错位变成负数。 */
function peerOnly(
  total: number | null | undefined,
  byUser: number | null | undefined,
): number {
  return Math.max(0, count(total) - count(byUser));
}

/** 这批计数在说的那件事：这些环节单个 AI 自己干时压根不会发生。 */
export const COLLAB_SUMMARY_TOOLTIP =
  "队伍里一个人替另一个人接住的环节：有人发现跑偏、有人被叫回重写、" +
  "有人拿不准先问过主管。都是本回合真实发生的动作计数，不是给结果打分；" +
  "你自己点的改方向和拍板不算在内。";

/**
 * 队友互相把关的一行；没有队友做的动作时返回 null（无可说则沉默）。
 *
 * 换的是说法不是数：后端计数原样用（`boundary_yields` = 中途把方向盘交出去、
 * `scope_signals` = 队员报出跑偏、`revises` = 定向唤回重写、`escalations` = 队员上报），
 * 只把「纠偏 / 漂移 / 唤回 / 上报」这套内部黑话换成用户读得懂的收益口径——同一批事实，
 * 原来的说法反而不准确：「漂移 1 次」听着像系统坏了，真相是有人跑偏、被另一个人拉回来了。
 *
 * 两处算术，都是为了不把同一件事或不属于队友的事算进来：
 *
 * 1. `escalations − scope_signals`：后端 `scope_signals` 数的是 `kind=scope` 的上报，本身
 *    就在 `escalations` 里（wave.py 从同一份 `state.escalations` 计两次）。两个数直接并列
 *    会把同一次上报数成两处，故减掉重叠，让两段互不相交。
 * 2. `− *_by_user`：这一行说的是「**队友**互相把关」，而 `revises` 里混着用户点「立即改
 *    此人」的热修、`boundary_yields` 里混着用户在计划复核上的拍板。把用户自己的操作报成
 *    队友互检，等于拿用户的动作给团队记功——他一眼就知道那次是自己点的。
 */
export function formatCollabSummary(
  collab: CollabCounts | null | undefined,
): string | null {
  if (!collab) return null;
  const scopeSignals = count(collab.scope_signals);
  const escalations = count(collab.escalations);
  const parts: string[] = [];
  if (scopeSignals > 0) parts.push(`发现跑偏 ${scopeSignals} 处`);
  const revises = peerOnly(collab.revises, collab.revises_by_user);
  if (revises > 0) parts.push(`返工重写 ${revises} 处`);
  const boundaryYields = peerOnly(
    collab.boundary_yields,
    collab.boundary_yields_by_user,
  );
  if (boundaryYields > 0) parts.push(`中途改分工 ${boundaryYields} 次`);
  const asked = Math.max(0, escalations - scopeSignals);
  if (asked > 0) parts.push(`先问再做 ${asked} 处`);
  return parts.length > 0 ? `互相把关：${parts.join(" · ")}` : null;
}
