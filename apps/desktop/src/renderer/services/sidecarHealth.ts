import type { SidecarTarget } from "@/services/sidecarRouting";
import { takeRecentSidecarFailure } from "@/services/sidecarStatus";

/**
 * 本地引擎（sidecar）会话级健康缓存 + 主动探活。
 *
 * 双模式工作区 §一.1 / 本地引擎毕业 · 探活增强。本地引擎毕业到**默认开**后，所有绑本机本地
 * 文件夹的对话都会走 sidecar——若用户机器环境起不来（杀软拦截 / 缺组件 / venv 损坏…），没有
 * 探活则每个回合都要「试 startTurn → 启动失败 → 降级回云端（阶段二）→ 弹一次提示」，反复打扰。
 *
 * 本模块把「首轮失败」前移成一次**主动探活**，并按 `root + subpath` 记住结果（app 进程内、
 * 会话级，不持久化）：
 *   - {@link probeSidecar}：首次走 sidecar 前调；未知则拉起进程 + initialize 握手（不跑回合）验
 *     证环境，成功标 `ok` / 失败标 `bad`（诊断取自 `sidecarStatus`）。已有结论则直接返回、不重探；
 *     `bad` 带 TTL——过期后允许再探，避免整会话无限静默走云。返回的 `probed` 区分「本次真探活」
 *     与「命中缓存」，让调用方对首探失败强制提示、对缓存续云节流提示。
 *   - {@link getSidecarHealth}：查询本会话对某根的健康结论（`ok`/`bad`/`unknown`），供测试断言 /
 *     UI 状态展示。路由判定（`resolveSidecarRoot`）**不**看它——健康收敛由各调用方按语义处理
 *     （`sendTurn` 探活失败走云、`runResume` 探活失败保留帧），见各处。
 *   - {@link markSidecarUnhealthy}：阶段二降级（探活通过、但回合启动期仍失败的边缘）也标 `bad`，
 *     与探活**共用**同一「记坏 → 命中缓存」出口，不形成第二条降级路径。
 *   - {@link clearSidecarHealth}：用户在设置里重新开启本地引擎时清空，给「修好环境后重试」机会。
 *   - {@link takeCloudBridgeToastSlot}：降云过桥 toast 节流槽（禁止整会话完全静默，也禁止每轮轰炸）。
 *
 * 探活成功留存的进程正好被随后的首个回合复用（主进程 `ensure` 命中缓存），故探活不浪费拉起。
 */

type Health = "ok" | "bad";

type HealthEntry = { health: Health; at: number };

/** `bad` 缓存 TTL：过期后 `probeSidecar` 再探一次（修好环境 / 偶发失败可恢复）。 */
export const BAD_HEALTH_TTL_MS = 5 * 60 * 1000;

/** 同一 key 的云端过桥 toast 最短间隔（首探失败 / 阶段二降级可 `force` 绕过）。 */
export const BRIDGE_TOAST_COOLDOWN_MS = 2 * 60 * 1000;

/** `rootId::subpath` → 本会话探明的健康（与主进程 `entryKey` 同构）。无项 = 未探活（unknown）。 */
const health = new Map<string, HealthEntry>();

/** 过桥 toast 节流：key → 上次成功占槽的墙钟。 */
const bridgeToastAt = new Map<string, number>();

function keyOf(target: SidecarTarget): string {
  return `${target.rootId}::${target.subpath}`;
}

function nowMs(): number {
  return Date.now();
}

/** 本会话对某 sidecar 目标的健康结论：`ok` 可走 / `bad` 跳过走云 / `unknown` 尚未探活。 */
export function getSidecarHealth(target: SidecarTarget): Health | "unknown" {
  const entry = health.get(keyOf(target));
  if (!entry) return "unknown";
  if (entry.health === "bad" && nowMs() - entry.at >= BAD_HEALTH_TTL_MS) {
    return "unknown";
  }
  return entry.health;
}

/**
 * 标记某 sidecar 目标本会话「环境起不来」（探活失败、或阶段二降级的边缘失败）。
 *
 * 标记后 `probeSidecar` 对该根在 TTL 内命中 `bad` 缓存（`probed:false`）；过期后允许再探。
 */
export function markSidecarUnhealthy(target: SidecarTarget): void {
  health.set(keyOf(target), { health: "bad", at: nowMs() });
}

/** 清空全部健康结论与过桥 toast 节流（用户在设置里重新开启本地引擎时调）。 */
export function clearSidecarHealth(): void {
  health.clear();
  bridgeToastAt.clear();
}

/**
 * 占用一次「云端过桥」toast 槽。返回 true = 调用方应弹出提示。
 *
 * - `force: true`：首探失败 / 阶段二启动期降级——必提示。
 * - 默认：缓存续云等路径走冷却，避免每轮轰炸，但不会整会话永远静默。
 */
export function takeCloudBridgeToastSlot(
  key: string,
  opts?: { force?: boolean },
): boolean {
  const now = nowMs();
  if (opts?.force) {
    bridgeToastAt.set(key, now);
    return true;
  }
  const last = bridgeToastAt.get(key) ?? 0;
  if (now - last < BRIDGE_TOAST_COOLDOWN_MS) return false;
  bridgeToastAt.set(key, now);
  return true;
}

/** 一次探活的结论：是否健康 + 本次是否真探活（区分首探 / 命中缓存）+ （失败时）可读诊断。 */
export interface SidecarProbeOutcome {
  healthy: boolean;
  /** 本次是否真执行了探活（true = 首探或 TTL 后再探；false = 命中 `ok`/`bad` 缓存或非桌面）。 */
  probed: boolean;
  detail: string | null;
}

/**
 * 探活一个 sidecar 目标（带会话级缓存）：未知则主动拉起 + 握手验证环境，已有结论则直接返回。
 *
 * 成功 → 标 `ok`、返回 healthy（留存的进程被随后首个回合复用）；失败 → 标 `bad`、返回带诊断的
 * unhealthy（诊断取自 `sidecarStatus` 的 onStatus 推送）。非桌面 / 未注入 `sidecarApi` 时视作
 * 不健康（调用方退回云链路）。`bad` 超过 {@link BAD_HEALTH_TTL_MS} 后视为未知并再探。
 */
export async function probeSidecar(
  target: SidecarTarget,
): Promise<SidecarProbeOutcome> {
  const key = keyOf(target);
  const cached = health.get(key);
  if (cached?.health === "ok") {
    return { healthy: true, probed: false, detail: null };
  }
  if (cached?.health === "bad") {
    if (nowMs() - cached.at < BAD_HEALTH_TTL_MS) {
      return { healthy: false, probed: false, detail: null };
    }
    health.delete(key);
  }

  if (typeof window === "undefined" || !window.sidecarApi) {
    return { healthy: false, probed: false, detail: null };
  }
  try {
    await window.sidecarApi.probe({
      rootId: target.rootId,
      subpath: target.subpath,
    });
    health.set(key, { health: "ok", at: nowMs() });
    return { healthy: true, probed: true, detail: null };
  } catch {
    health.set(key, { health: "bad", at: nowMs() });
    // 诊断由主进程 onStatus(error) 推入 sidecarStatus；取走它换出针对性提示（取不到则 null，
    // 由调用方退回通用兜底文案）。
    return {
      healthy: false,
      probed: true,
      detail: takeRecentSidecarFailure(target.rootId),
    };
  }
}
