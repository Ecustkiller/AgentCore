import { notifyInfo } from "@/lib/toast";
import { type HandoffJob, listHandoffJobs } from "@/services/handoff";
import {
  type WorkspaceMode,
  getWorkspaceBinding,
} from "@/services/workspaceBinding";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * 后台云端任务 store（双模式工作区 P2e —— 交接的「方案 B」前端态）。
 *
 * 把本地→云交接从工作区侧栏的孤岛搬进对话：一条本地模式对话「在云端后台跑」的任务
 * 就是这里的一项。数据沿用 `services/handoff` 的 `HandoffJob`（后端 `/handoff/jobs`
 * 持久化），故卡片随对话重开自然重放——无需在消息表另落占位行（方案 i 的「原位重放」
 * 目标用「按时间戳并入时间线」达成，零 schema 改动）。
 *
 * `modeByConversation` 缓存每个对话的云/本地判定（`getWorkspaceBinding`），供输入框的
 * 「后台」开关与本 feed 共用一次请求（`ensureMode` 去重并发拉取）——交接只在本地模式
 * 存在，故云端对话零额外拉取。
 *
 * §7.6 心智：云端改的是拷贝；合回本机须用户点一下。徽章优先信后端
 * `applied` / `discarded`；`mergedJobIds` 仅作本会话合回后的乐观/兼容（勿与后端打架）。
 * 轮询到新 succeeded 时给一次 toast（按 job id 去重，不对历史已成功作业刷屏）。
 */
interface BackgroundTasksState {
  /** conversationId → 其后台云端任务（后端按时间倒序返回）。 */
  byConversation: Record<string, HandoffJob[]>;
  /** conversationId → 工作区模式（cloud / local），解析后缓存。 */
  modeByConversation: Record<string, WorkspaceMode>;
  /** conversationId → 绑定的本地根 id（本地模式才有；云端 / 未解析为 null）。 */
  rootIdByConversation: Record<string, string | null>;
  /**
   * 本会话乐观「已合回」标记（apply 成功瞬间、或确认无需合回）。权威态以 job.status
   * `applied`/`discarded` 为准；本表不覆盖后端 discarded。
   */
  mergedJobIds: Record<string, true>;
  /** 本会话已 toast 过的 succeeded job id（禁止累计骚扰）。 */
  toastedSucceededIds: Record<string, true>;
  /** 用服务端权威列表覆盖某对话的任务（`listHandoffJobs`）。 */
  load: (conversationId: string) => Promise<void>;
  /** 插入 / 替换单项（乐观派发的临时项，或轮询刷新）。 */
  upsert: (conversationId: string, job: HandoffJob) => void;
  /** 乐观标记已合回本机 / 无需合回（卡面在后端尚未刷到 applied 前用）。 */
  markMerged: (jobId: string) => void;
  /**
   * 解析并缓存某对话的工作区模式 + 绑定根 id；与输入框共用，去重并发请求。失败回落
   * cloud / null。返回 mode（rootId 经 `useWorkspaceRootId` 读取，供成功任务的内联评审
   * 写回本地用）。
   */
  ensureMode: (conversationId: string) => Promise<WorkspaceMode>;
  /** 删除对话时丢掉该会话的任务列表 / 模式缓存，避免分桶泄漏。 */
  clearConversation: (conversationId: string) => void;
}

/** ensureMode 的并发去重：同一对话多处同时问模式，只打一次 binding 请求。 */
const modeInFlight = new Map<string, Promise<WorkspaceMode>>();

export const useBackgroundTasksStore = create<BackgroundTasksState>(
  (set, get) => ({
    byConversation: {},
    modeByConversation: {},
    rootIdByConversation: {},
    mergedJobIds: {},
    toastedSucceededIds: {},
    load: async (conversationId) => {
      const prev = get().byConversation[conversationId] ?? [];
      const jobs = await listHandoffJobs(conversationId);
      const hadInFlight = prev.some(
        (j) => j.status === "pending" || j.status === "running",
      );
      const toToast: string[] = [];
      if (hadInFlight) {
        const { mergedJobIds, toastedSucceededIds } = get();
        for (const job of jobs) {
          if (job.status !== "succeeded") continue;
          if (mergedJobIds[job.id] || toastedSucceededIds[job.id]) continue;
          toToast.push(job.id);
        }
      }
      set((s) => {
        const toastedSucceededIds =
          toToast.length === 0
            ? s.toastedSucceededIds
            : {
                ...s.toastedSucceededIds,
                ...Object.fromEntries(toToast.map((id) => [id, true as const])),
              };
        return {
          byConversation: { ...s.byConversation, [conversationId]: jobs },
          toastedSucceededIds,
        };
      });
      if (toToast.length === 1) {
        notifyInfo("云端拷贝已改完", {
          description: "点卡片可查看改动并合回本机（不会自动写入本机文件夹）",
        });
      } else if (toToast.length > 1) {
        notifyInfo(`${toToast.length} 个云端拷贝已改完`, {
          description:
            "点对应卡片可查看改动并合回本机（不会自动写入本机文件夹）",
        });
      }
    },
    upsert: (conversationId, job) =>
      set((s) => {
        const prev = s.byConversation[conversationId] ?? [];
        const next = prev.some((j) => j.id === job.id)
          ? prev.map((j) => (j.id === job.id ? job : j))
          : [job, ...prev];
        return {
          byConversation: { ...s.byConversation, [conversationId]: next },
        };
      }),
    markMerged: (jobId) =>
      set((s) =>
        s.mergedJobIds[jobId]
          ? s
          : { mergedJobIds: { ...s.mergedJobIds, [jobId]: true } },
      ),
    ensureMode: async (conversationId) => {
      const cached = get().modeByConversation[conversationId];
      if (cached) return cached;
      const pending = modeInFlight.get(conversationId);
      if (pending) return pending;
      const p = (async () => {
        let mode: WorkspaceMode = "cloud";
        let rootId: string | null = null;
        try {
          const binding = await getWorkspaceBinding(conversationId);
          mode = binding.mode;
          rootId = binding.rootId;
        } catch {
          // Binding unknown (e.g. a never-sent draft) — treat as cloud so the
          // background entry stays hidden and the feed never lists.
        }
        set((s) => ({
          modeByConversation: {
            ...s.modeByConversation,
            [conversationId]: mode,
          },
          rootIdByConversation: {
            ...s.rootIdByConversation,
            [conversationId]: rootId,
          },
        }));
        modeInFlight.delete(conversationId);
        return mode;
      })();
      modeInFlight.set(conversationId, p);
      return p;
    },
    clearConversation: (conversationId) => {
      modeInFlight.delete(conversationId);
      set((s) => {
        const { [conversationId]: _jobs, ...byConversation } = s.byConversation;
        const { [conversationId]: _mode, ...modeByConversation } =
          s.modeByConversation;
        const { [conversationId]: _root, ...rootIdByConversation } =
          s.rootIdByConversation;
        // Drop merged / toasted flags for jobs that belonged to this conversation.
        const dropped = new Set(
          (s.byConversation[conversationId] ?? []).map((j) => j.id),
        );
        let mergedJobIds = s.mergedJobIds;
        let toastedSucceededIds = s.toastedSucceededIds;
        if (dropped.size > 0) {
          mergedJobIds = { ...s.mergedJobIds };
          toastedSucceededIds = { ...s.toastedSucceededIds };
          for (const id of dropped) {
            delete mergedJobIds[id];
            delete toastedSucceededIds[id];
          }
        }
        return {
          byConversation,
          modeByConversation,
          rootIdByConversation,
          mergedJobIds,
          toastedSucceededIds,
        };
      });
    },
  }),
);

const EMPTY: HandoffJob[] = [];

/** 选择器：某对话的后台云端任务（无 / 未加载时返回稳定空数组，避免重渲染）。 */
export function useBackgroundTasks(
  conversationId: string | null,
): HandoffJob[] {
  return useBackgroundTasksStore((s) =>
    conversationId ? (s.byConversation[conversationId] ?? EMPTY) : EMPTY,
  );
}

/**
 * 选择器：某对话绑定的本地根 id（`ensureMode` 解析后才有）。供成功任务的内联评审把
 * 云端结果写回本地（`readLocalShas` / `applyHandoffJob` 都按根 id 在绑定根上履行 op）。
 * 云端 / 未解析 / 解析失败为 null —— 此时卡片不提供评审入口。
 */
export function useWorkspaceRootId(
  conversationId: string | null,
): string | null {
  return useBackgroundTasksStore((s) =>
    conversationId ? (s.rootIdByConversation[conversationId] ?? null) : null,
  );
}

/** 选择器：作业是否本会话乐观标记已合回（权威态见 job.status applied/discarded）。 */
export function useBackgroundTaskMerged(jobId: string): boolean {
  return useBackgroundTasksStore((s) => Boolean(s.mergedJobIds[jobId]));
}

/**
 * 同步某对话的后台云端任务：模式解析为 local 时拉一次列表，并在有进行中任务时轮询
 * （MVP=轮询，4s，与原交接面板同节奏）。云端对话不拉取。
 */
export function useBackgroundTasksSync(conversationId: string | null): void {
  const ensureMode = useBackgroundTasksStore((s) => s.ensureMode);
  const load = useBackgroundTasksStore((s) => s.load);
  const mode = useBackgroundTasksStore((s) =>
    conversationId ? s.modeByConversation[conversationId] : undefined,
  );
  const tasks = useBackgroundTasks(conversationId);
  const inFlight = tasks.some(
    (t) => t.status === "pending" || t.status === "running",
  );

  useEffect(() => {
    if (conversationId) void ensureMode(conversationId);
  }, [conversationId, ensureMode]);

  useEffect(() => {
    if (!conversationId || mode !== "local") return;
    void load(conversationId).catch(() => {});
  }, [conversationId, mode, load]);

  useEffect(() => {
    if (!conversationId || mode !== "local" || !inFlight) return;
    const id = setInterval(
      () => void load(conversationId).catch(() => {}),
      4000,
    );
    return () => clearInterval(id);
  }, [conversationId, mode, inFlight, load]);
}
