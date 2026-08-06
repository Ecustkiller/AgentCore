import {
  SIDECAR_CHANNELS,
  type SidecarAttachRequest,
  type SidecarAttachResponse,
  type SidecarCancelRequest,
  type SidecarDebateSteerRequest,
  type SidecarInference,
  type SidecarListBrowserSessionsRequest,
  type SidecarListBrowserSessionsResult,
  type SidecarRecoveryRequest,
  type SidecarRecoveryResponse,
  type SidecarRespondRequest,
  type SidecarRestoreTurnBaselineRequest,
  type SidecarResumeRequest,
  type SidecarRunRedirectRequest,
  type SidecarStartTurnRequest,
  type SidecarStatusPush,
  type SidecarTurnFilesDiffRequest,
  type SidecarTurnFilesDiffResult,
  type SidecarTurnResult,
  buildSidecarResumeRpcParams,
} from "@shared/sidecar-contract";
import { BrowserWindow, type WebContents } from "electron";
import { getDesktopBrowserBridgeCredentials } from "../browser";
import { listSessionRoots } from "../fs/roots";
import { logDesktop } from "../log-service";
import { listUnsyncedSummaries, sidecarDataDir } from "../outbox-writeback";
import { SidecarEventBuffer } from "../sidecar-event-buffer";
import { SidecarClient } from "./client";
import { readLocalPausedRecovery } from "./recovery";
import {
  type SpawnConfig,
  type Transport,
  resolveSpawnConfig,
  spawnTransport,
} from "./transport";
import { entryKey } from "./workspace";

// 本地回合的审批门（双模式工作区 §十）。开启后，sidecar 引擎对 worker 的「碰真实
// 机器」工具（file_write / code_execute 等 GRANTABLE）挂起审批，与云端 local 模式同语义——
// 审批请求随回合事件流回 renderer，用户的决定经 `window.sidecarApi.respond` 结算回这条 stdio
// 链路（renderer 把统一结算入口 `resolveInteraction` 在本地回合改走 sidecar）。
const SIDECAR_APPROVALS_ENABLED = true;

/**
 * DesktopBrowserBridge 本回合句柄（B-Arch · 与 inference 同构）。
 * 主进程签发；经 initialize / startTurn / resume 下发，不再依赖 spawn env。
 */
function currentBrowserBridge(): { baseUrl: string; token: string } | null {
  const creds = getDesktopBrowserBridgeCredentials();
  if (!creds) return null;
  return { baseUrl: creds.baseUrl, token: creds.token };
}

interface SidecarEntry {
  client: SidecarClient;
  /** initialize 的就绪 Promise（失败则该 entry 已被逐出，需重拉）。 */
  ready: Promise<void>;
}

interface ActiveTurn {
  wc: WebContents;
  conversationId: string;
  rootId: string;
  subpath: string;
  kind: "start" | "resume";
  traceId: string;
  /** startTurn：用户行 id；resume：挂起时落库的 user 行 id（可缺省）。 */
  userMessageId?: string;
  userMessage?: string;
  /** resume 登记键 = assistant message_id；startTurn 亦可在 finalize 前未知。 */
  messageId?: string;
  buffer: SidecarEventBuffer;
  /** 本回合是否曾被 attach 重绑过（合成终止事件的门闩）。 */
  hasAttached: boolean;
  /** attach 零 await 段内为 true：只入缓冲、不转发（互斥不重不漏）。 */
  attaching: boolean;
}

/**
 * 管理每个授权根的 sidecar：懒拉起 + 初始化、回合事件路由、cancel/respond、退出清理。
 *
 * `spawnFn` 可注入（默认真实 `spawnTransport`），便于单测用假传输驱动整条链路。
 */
export class SidecarManager {
  private readonly entries = new Map<string, SidecarEntry>();
  private readonly turns = new Map<string, ActiveTurn>();

  constructor(
    private readonly spawnFn: (
      config: SpawnConfig,
    ) => Transport = spawnTransport,
  ) {}

  /**
   * 拉起（或复用）某 `root + subpath` 的 sidecar，并完成一次性 initialize。
   *
   * `workspaceRoot` 已是绑定根目录（容器根 absPath 拼上子路径，由 IPC handler 算好），即引擎本
   * 回合的工作区；缓存键含 subpath，故同容器根下的不同子路径工作区互不串台。状态推送仍按容器
   * `rootId`（与 renderer 的 sidecarStatus / `takeRecentSidecarFailure(rootId)` 对齐——诊断按根聚合）。
   */
  private ensure(
    rootId: string,
    subpath: string,
    workspaceRoot: string,
    inference: SidecarInference | undefined,
  ): SidecarEntry {
    const key = entryKey(rootId, subpath);
    const existing = this.entries.get(key);
    if (existing) return existing;

    const transport = this.spawnFn(resolveSpawnConfig());
    const client = new SidecarClient(transport);
    client.onNotification((method, params) =>
      this.onNotification(method, params),
    );
    client.onClosed((err) => {
      this.entries.delete(key);
      this.pushStatus({ rootId, phase: "exited", detail: err.message });
    });

    const ready = client
      .request("initialize", {
        userId: "local",
        workspaceRoot,
        approvalsEnabled: SIDECAR_APPROVALS_ENABLED,
        // The app-private data dir for durable pause frames (双模式工作区 §一.1):
        // its presence flips the engine's local paused-turn store on.
        dataDir: sidecarDataDir(),
        ...(inference ? { inference } : {}),
        // Always send key (null when Bridge not Ready) so sidecar clears sticky env.
        browserBridge: currentBrowserBridge(),
      })
      .then(() => {
        this.pushStatus({ rootId, phase: "spawned" });
      })
      .catch((err: unknown) => {
        // 初始化失败（uv/venv 找不到、引擎导入失败等）——逐出，下次重拉；上抛给 startTurn。
        this.entries.delete(key);
        const detail = err instanceof Error ? err.message : String(err);
        this.pushStatus({ rootId, phase: "error", detail });
        client.dispose();
        throw err instanceof Error ? err : new Error(detail);
      });

    const entry: SidecarEntry = { client, ready };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * 在某根的 sidecar 上跑一个回合；Promise 在回合结束时 resolve（携带最终结果），
   * 过程事件经 `sidecar:event` 推给 `wc`。
   */
  async startTurn(
    wc: WebContents,
    req: SidecarStartTurnRequest,
    workspaceRoot: string,
  ): Promise<SidecarTurnResult> {
    const entry = this.ensure(
      req.rootId,
      req.subpath ?? "",
      workspaceRoot,
      req.inference,
    );
    await entry.ready; // 初始化失败则在此抛出 → renderer 据此降级

    this.turns.set(req.turnId, {
      wc,
      conversationId: req.conversationId,
      rootId: req.rootId,
      subpath: req.subpath ?? "",
      kind: "start",
      traceId: req.traceId,
      userMessageId: req.userMessageId,
      userMessage: req.userMessage,
      buffer: new SidecarEventBuffer(),
      hasAttached: false,
      attaching: false,
    });
    try {
      const sessionRoots = listSessionRoots(req.conversationId);
      const externalMounts = sessionRoots
        .filter((r) => r.alias && r.absPath)
        .map((r) => ({
          alias: r.alias as string,
          rootId: r.id,
          label: r.name,
          absPath: r.absPath,
          mode: r.mode === "organize" ? "organize" : "readonly",
        }));
      const result = await entry.client.request("startTurn", {
        turnId: req.turnId,
        conversationId: req.conversationId,
        traceId: req.traceId,
        userMessage: req.userMessage,
        // Outbox idempotency anchor (as-built: 双模式工作区 §10.3).
        userMessageId: req.userMessageId,
        history: req.history ?? [],
        // W3: session read-only mounts (abs paths stay in main → sidecar only).
        ...(externalMounts.length > 0 ? { externalMounts } : {}),
        // Re-send the current cloud-proxy token every turn: the sidecar is long-lived
        // but the token rotates (12h TTL), so the engine adopts the fresh one per turn
        // (initialize-time creds would otherwise 401 after expiry).
        ...(req.inference ? { inference: req.inference } : {}),
        // Same for DesktopBrowserBridge (B-Arch): refresh every turn; null = 未装配.
        browserBridge: currentBrowserBridge(),
        // 会话权限轴按回合随送：中途切换后下一回合即生效。
        ...(req.permissionAxes ? { permissionAxes: req.permissionAxes } : {}),
      });
      this.emitSyntheticTerminalIfNeeded(req.turnId, "message_end");
      return result as SidecarTurnResult;
    } catch (err) {
      this.emitSyntheticTerminalIfNeeded(req.turnId, "error", err);
      throw err;
    } finally {
      this.turns.delete(req.turnId);
    }
  }

  /**
   * 探活某 `root + subpath` 的 sidecar：拉起（或复用）进程并完成 initialize 握手即返回，不跑
   * 任何回合。用于在首次真正走 sidecar 前提前验证本机环境（Python / venv / 引擎导入 / 工作区
   * 绑定）能起得来；握手成功留存的进程正好被随后的首个回合复用（`ensure` 命中缓存、零额外拉
   * 起）。失败时 `ensure` 的 `ready` 已 pushStatus(error) + 逐出该 entry，错误上抛给调用方。
   */
  async probe(
    rootId: string,
    subpath: string,
    workspaceRoot: string,
  ): Promise<void> {
    // 不传 inference：探活只验证环境能起；真实回合的 startTurn 会按回合重发云代理凭据。
    const entry = this.ensure(rootId, subpath, workspaceRoot, undefined);
    await entry.ready;
  }

  /** A1+ 本机真 diff：ensure sidecar → `turnFilesDiff` RPC（相对本地基线 zip）。 */
  async turnFilesDiff(
    req: SidecarTurnFilesDiffRequest,
    workspaceRoot: string,
  ): Promise<SidecarTurnFilesDiffResult> {
    const entry = this.ensure(
      req.rootId,
      req.subpath ?? "",
      workspaceRoot,
      undefined,
    );
    await entry.ready;
    const params: Record<string, unknown> = { messageId: req.messageId };
    if (req.baselineSnapshotId) {
      params.baselineSnapshotId = req.baselineSnapshotId;
    }
    return entry.client.request(
      "turnFilesDiff",
      params,
    ) as Promise<SidecarTurnFilesDiffResult>;
  }

  /** A2′ 本机回退：ensure sidecar → `restoreTurnBaseline`（unzip，不经云）。 */
  async restoreTurnBaseline(
    req: SidecarRestoreTurnBaselineRequest,
    workspaceRoot: string,
  ): Promise<void> {
    const entry = this.ensure(
      req.rootId,
      req.subpath ?? "",
      workspaceRoot,
      undefined,
    );
    await entry.ready;
    await entry.client.request("restoreTurnBaseline", {
      snapshotId: req.snapshotId,
    });
  }

  /** Local hydrate: ensure sidecar → `listBrowserSessions`（同进程 Registry）。 */
  async listBrowserSessions(
    req: SidecarListBrowserSessionsRequest,
    workspaceRoot: string,
  ): Promise<SidecarListBrowserSessionsResult> {
    const entry = this.ensure(
      req.rootId,
      req.subpath ?? "",
      workspaceRoot,
      undefined,
    );
    await entry.ready;
    return entry.client.request("listBrowserSessions", {
      conversationId: req.conversationId,
    }) as Promise<SidecarListBrowserSessionsResult>;
  }

  /**
   * 续跑一个持久挂起的本地回合（结构化挂起 2b）。
   *
   * 与 `startTurn` 同构：拉起 / 复用该根 sidecar，claim 本机帧并跑 `resume_chat_pipeline`，
   * Promise 在续跑结束时携最终结果 resolve（供 renderer 回写云端），过程事件经 `sidecar:event`
   * 推回。事件路由键用 message_id（一回合至多一个持久挂起）。
   */
  async resume(
    wc: WebContents,
    req: SidecarResumeRequest,
    workspaceRoot: string,
    inference: SidecarInference | undefined,
  ): Promise<SidecarTurnResult> {
    const entry = this.ensure(
      req.rootId,
      req.subpath ?? "",
      workspaceRoot,
      inference,
    );
    await entry.ready;

    this.turns.set(req.messageId, {
      wc,
      conversationId: req.conversationId,
      rootId: req.rootId,
      subpath: req.subpath ?? "",
      kind: "resume",
      traceId: req.traceId,
      userMessageId: req.userMessageId,
      messageId: req.messageId,
      buffer: new SidecarEventBuffer(),
      hasAttached: false,
      attaching: false,
    });
    try {
      const sessionRoots = listSessionRoots(req.conversationId);
      const externalMounts = sessionRoots
        .filter((r) => r.alias && r.absPath)
        .map((r) => ({
          alias: r.alias as string,
          rootId: r.id,
          label: r.name,
          absPath: r.absPath,
          mode: r.mode === "organize" ? "organize" : "readonly",
        }));
      const result = await entry.client.request("resume", {
        ...buildSidecarResumeRpcParams(req, inference, currentBrowserBridge()),
        ...(externalMounts.length > 0 ? { externalMounts } : {}),
      });
      this.emitSyntheticTerminalIfNeeded(req.messageId, "message_end");
      return result as SidecarTurnResult;
    } catch (err) {
      this.emitSyntheticTerminalIfNeeded(req.messageId, "error", err);
      throw err;
    } finally {
      this.turns.delete(req.messageId);
    }
  }

  /**
   * Local recovery query: live turn + outbox unsynced + paused frames. Zero spawn.
   */
  async recovery(
    req: SidecarRecoveryRequest,
  ): Promise<SidecarRecoveryResponse> {
    const live = this.findLiveTurn(req.conversationId);
    const [unsynced, localPaused] = await Promise.all([
      listUnsyncedSummaries(req.conversationId),
      readLocalPausedRecovery(req.conversationId),
    ]);
    const { paused, pausedRuns } = localPaused;
    // Exclude the live turn's open row — D5 projects ready + dead-open only;
    // live content comes from attach replay.
    const filtered = live
      ? unsynced.filter((u) => {
          if (live.turn.kind === "start" && live.turn.userMessageId) {
            return u.user_message_id !== live.turn.userMessageId;
          }
          if (live.turn.kind === "resume" && live.turn.messageId) {
            return u.message_id !== live.turn.messageId;
          }
          return true;
        })
      : unsynced;
    logDesktop({
      level: "info",
      event: "sidecar.recovery",
      fields: {
        conversation_id: req.conversationId,
        live_running: live !== null,
        unsynced_count: filtered.length,
        paused_count: paused.length,
        paused_runs_count: Object.keys(pausedRuns).length,
      },
    });
    return {
      liveRunning: live !== null,
      ...(live ? { turnId: live.turnId } : {}),
      unsynced: filtered,
      paused,
      ...(Object.keys(pausedRuns).length > 0 ? { pausedRuns } : {}),
    };
  }

  /**
   * Rebind the live turn's WebContents and snapshot the event buffer (D4).
   *
   * **Zero-await hard constraint** between rebind and snapshot: every event is
   * either in the returned snapshot or forwarded to the new wc — never both,
   * never lost. Callers must not insert awaits in this method.
   */
  attach(wc: WebContents, req: SidecarAttachRequest): SidecarAttachResponse {
    const live = this.findLiveTurn(req.conversationId);
    if (!live) {
      logDesktop({
        level: "info",
        event: "sidecar.attach",
        fields: {
          conversation_id: req.conversationId,
          attached: false,
          buffer_length: 0,
        },
      });
      return { attached: false };
    }
    // --- zero-await section (do not await) ---
    live.turn.attaching = true;
    live.turn.wc = wc;
    live.turn.hasAttached = true;
    const events = live.turn.buffer.snapshot();
    live.turn.attaching = false;
    // --- end zero-await section ---
    logDesktop({
      level: "info",
      event: "sidecar.attach",
      fields: {
        conversation_id: req.conversationId,
        attached: true,
        turn_id: live.turnId,
        buffer_length: events.length,
      },
    });
    return {
      attached: true,
      turnId: live.turnId,
      rootId: live.turn.rootId,
      subpath: live.turn.subpath,
      userMessageId: live.turn.userMessageId,
      userMessage: live.turn.userMessage,
      traceId: live.turn.traceId,
      messageId: live.turn.messageId,
      kind: live.turn.kind,
      events,
    };
  }

  /**
   * 取消一个在跑的回合。无对应 sidecar / RPC 失败时抛错，供 FE 可见提示
   * （勿静默吞——请求失败时用户需要知道信号没发出去，可再点停止）。
   */
  async cancel(req: SidecarCancelRequest): Promise<void> {
    const entry = this.entries.get(entryKey(req.rootId, req.subpath));
    if (!entry) {
      throw new Error("本地引擎未运行，无法停止");
    }
    await entry.client.request("cancel", {
      turnId: req.turnId,
      ...(req.conversationId ? { conversationId: req.conversationId } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
    });
  }

  /** 用户中途改某个 worker 的方向（队列入队；Step 2 由 scheduler 消费）。 */
  async runRedirect(req: SidecarRunRedirectRequest): Promise<void> {
    const entry = this.entries.get(entryKey(req.rootId, req.subpath));
    if (!entry) return;
    try {
      await entry.client.request("runRedirect", {
        conversationId: req.conversationId,
        executionId: req.executionId,
        runId: req.runId,
        feedback: req.feedback,
      });
    } catch {
      // sidecar 不可达时静默——与 cancel 一致。
    }
  }

  /** 辩论 ambient 掌舵（fire-and-forget，下一轮边界生效）。 */
  async debateSteer(req: SidecarDebateSteerRequest): Promise<void> {
    const entry = this.entries.get(entryKey(req.rootId, req.subpath));
    if (!entry) return;
    try {
      await entry.client.request("debateSteer", {
        conversationId: req.conversationId,
        executionId: req.executionId,
        decision: req.decision,
        focus: req.focus ?? "",
        ask: req.ask ?? "",
        askTarget: req.askTarget ?? "",
      });
    } catch {
      // sidecar 不可达时静默——与 runRedirect 一致。
    }
  }

  /** 结算一个被挂起的交互（审批 / ask_user / 本地工具）。 */
  async respond(req: SidecarRespondRequest): Promise<{ resolved: boolean }> {
    const entry = this.entries.get(entryKey(req.rootId, req.subpath));
    if (!entry) {
      throw new Error(
        `本地引擎未就绪（root=${req.rootId} subpath=${req.subpath ?? ""}），无法结算交互`,
      );
    }
    const reply = (await entry.client.request("respond", {
      requestId: req.requestId,
      conversationId: req.conversationId,
      result: req.result,
    })) as { resolved?: boolean } | null;
    return { resolved: Boolean(reply?.resolved) };
  }

  /** 退出时清理所有 sidecar（尽力发 shutdown 再终止进程）。 */
  disposeAll(): void {
    for (const [, entry] of this.entries) {
      void entry.client.request("shutdown", {}).catch(() => {});
      entry.client.dispose();
    }
    this.entries.clear();
    this.turns.clear();
  }

  private onNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method !== "turn/event") return;
    const turnId = String(params.turnId ?? "");
    const turn = this.turns.get(turnId);
    if (!turn) return;

    const raw = params.event;
    const event =
      raw && typeof raw === "object"
        ? (raw as {
            type?: string;
            timestamp?: string;
            payload?: unknown;
          })
        : null;
    if (!event?.type) return;

    const buffered = {
      type: String(event.type),
      timestamp:
        typeof event.timestamp === "string"
          ? event.timestamp
          : new Date().toISOString(),
      payload: event.payload,
    };
    // Buffer first (even when wc is destroyed) so refresh attach can replay.
    turn.buffer.record(buffered);

    // During attach's zero-await window: buffer only — snapshot owns those events.
    if (turn.attaching || turn.wc.isDestroyed()) return;
    turn.wc.send(SIDECAR_CHANNELS.event, {
      conversationId: turn.conversationId,
      turnId,
      event: buffered,
    });
  }

  /**
   * Before `turns.delete`: if an attached window never saw a terminal event,
   * synthesize one so the bubble cannot hang on「生成中」(D4 收尾必达).
   */
  private emitSyntheticTerminalIfNeeded(
    turnId: string,
    kind: "message_end" | "error",
    err?: unknown,
  ): void {
    const turn = this.turns.get(turnId);
    if (!turn || !turn.hasAttached) return;
    if (turn.buffer.hasTerminal()) return;

    const event = {
      type: kind,
      timestamp: new Date().toISOString(),
      payload:
        kind === "error"
          ? {
              code: "sidecar_turn_ended",
              message:
                err instanceof Error
                  ? err.message
                  : err
                    ? String(err)
                    : "本地回合异常结束",
            }
          : {},
    };
    turn.buffer.record(event);
    if (!turn.wc.isDestroyed()) {
      turn.wc.send(SIDECAR_CHANNELS.event, {
        conversationId: turn.conversationId,
        turnId,
        event,
      });
    }
  }

  private findLiveTurn(
    conversationId: string,
  ): { turnId: string; turn: ActiveTurn } | null {
    for (const [turnId, turn] of this.turns) {
      if (turn.conversationId === conversationId) {
        return { turnId, turn };
      }
    }
    return null;
  }

  private pushStatus(push: SidecarStatusPush): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(SIDECAR_CHANNELS.status, push);
      }
    }
  }
}
