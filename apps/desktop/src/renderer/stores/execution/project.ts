import type { DebateNarrativeRound, DebateResultPayload } from "@/types/events";
import type { RunFrame } from "./frames";
import {
  type AgentState,
  type Execution,
  type ExecutionPlan,
  type ExecutionStatus,
  type RunNode,
  toolLabel,
} from "./types";

/**
 * Fold a prefix of the frame stream into a full {@link Execution} snapshot.
 *
 * Pure and deterministic: feeding `frames.slice(0, n)` yields the exact state
 * the graph had after the n-th fact, which is what powers timeline replay.
 */
export function projectExecution(
  plan: ExecutionPlan,
  frames: RunFrame[],
  status: ExecutionStatus,
  debate: DebateResultPayload | null = null,
  debateRounds: DebateNarrativeRound[] = [],
): Execution {
  const agents: AgentState[] = plan.agents.map((a) => ({
    id: a.id,
    role: a.role,
    modelPreference: a.modelPreference,
    thinking: a.thinking ?? true,
    reasoningEffort: a.reasoningEffort ?? "high",
    status: "idle",
    currentRunId: null,
    outputChunks: [],
    reasoningChunks: [],
    toolCalls: [],
    toolProgress: null,
  }));
  const runs: RunNode[] = plan.runs.map((s) => ({
    id: s.id,
    agentId: s.agentId,
    task: s.task,
    status: "pending",
    dependsOn: s.dependsOn,
    outputSummary: null,
    durationMs: null,
    error: null,
    // Plan-declared parent so the 子任务 tree + graph grouping work before the
    // run_started frame folds in (the frame re-confirms it). 阶段1 flat workers
    // resolve to a CEO-captain id with no node, treated as "no parent here".
    parentRunId: s.parentRunId ?? null,
    // Plan-declared kind so the captain 汇聚点 is identifiable before its
    // run_started frame folds in (the frame re-confirms it).
    kind: s.kind ?? "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    // 辩论/审查 display tags ride straight from the plan (no run frame mutates
    // them — they are declared once and immutable).
    stance: s.stance ?? null,
    group: s.group ?? null,
    round: s.round ?? 0,
    // Plan runs are never revisions; a revision is synthesized from its frame.
    revisionOf: null,
    revision: 0,
    // No「计划已调整」trace until a plan_revised frame folds in (设计 §7.2).
    revised: null,
    // No checkpoint until a plan_review frame folds in (结构化挂起 2a).
    checkpoint: null,
    // No received context until the run_context frame folds in (上下文传递可视化).
    receivedContext: [],
    // No escalations until a run_escalation frame folds in (升级实时可见).
    escalations: [],
  }));

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const runById = (id: string) => runs.find((s) => s.id === id);

  // plan_review_resolved carries only the checkpoint id, so remember which step
  // run ids each pause gated on (from its _required frame) to apply the decision.
  const checkpointSteps = new Map<string, string[]>();

  for (const f of frames) {
    switch (f.kind) {
      case "run_started": {
        let run = runById(f.runId);
        // 定向唤回 续写 (乙 热修 P4): a revision (`revision >= 2`) is NOT in the plan —
        // it is born from this frame. Synthesize its run + agent, inheriting the
        // ORIGINAL's display identity (role / tier / task), and hang it off the
        // original as a「修订 vN」child so its output / cost / status fold in just
        // like a planned worker. Guarded on the original existing, so a stray
        // revision frame (parent not on this graph) is ignored, not mis-drawn.
        if (!run && f.revision > 0 && f.parentRunId) {
          const original = runById(f.parentRunId);
          if (original) {
            const originAgent = agentById(original.agentId);
            agents.push({
              id: f.agentId,
              role: originAgent?.role ?? original.agentId,
              modelPreference: originAgent?.modelPreference ?? "strong",
              thinking: originAgent?.thinking ?? true,
              reasoningEffort: originAgent?.reasoningEffort ?? "high",
              status: "idle",
              currentRunId: null,
              outputChunks: [],
              reasoningChunks: [],
              toolCalls: [],
              toolProgress: null,
            });
            run = {
              id: f.runId,
              agentId: f.agentId,
              task: original.task,
              status: "pending",
              dependsOn: [],
              outputSummary: null,
              durationMs: null,
              error: null,
              parentRunId: f.parentRunId,
              kind: f.runKind,
              role: null,
              model: null,
              usage: null,
              cost: null,
              stance: null,
              group: null,
              round: 0,
              revisionOf: f.parentRunId,
              revision: f.revision,
              revised: null,
              checkpoint: null,
              receivedContext: [],
              escalations: [],
            };
            runs.push(run);
          }
        }
        if (run) {
          run.status = "running";
          // Capture the 阶段2 declaration slots onto the node so a later graph
          // can read them from the projected run (inert in 阶段1).
          run.parentRunId = f.parentRunId;
          run.kind = f.runKind;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "working";
          agent.currentRunId = f.runId;
          agent.toolProgress = null;
        }
        break;
      }
      case "run_context": {
        // 收到的上下文 (上下文传递可视化): record the structured context this run was
        // fed onto its node, so the detail panel shows exactly what the LLM saw.
        // The captain's own context is TURN-LEVEL (the message bubble, not a node):
        // skip it here so a multi-agent journal replay doesn't paint the CEO node.
        const run = runById(f.runId);
        if (run && run.kind !== "captain") run.receivedContext = f.blocks;
        break;
      }
      case "run_output_delta": {
        const agent = agentById(f.agentId);
        if (agent) agent.outputChunks.push(f.delta);
        break;
      }
      case "run_reasoning_delta": {
        const agent = agentById(f.agentId);
        if (agent) agent.reasoningChunks.push(f.delta);
        break;
      }
      case "run_tool_progress": {
        // The worker is composing a tool call's arguments (the file body for
        // file_write, …): light up the live「正在生成」line. Cleared when the call
        // starts executing (tool_use_start) or the run ends.
        const agent = agentById(f.agentId);
        if (agent)
          agent.toolProgress = { toolName: f.toolName, chars: f.chars };
        break;
      }
      case "run_completed": {
        const run = runById(f.runId);
        if (run) {
          run.status = "completed";
          run.outputSummary = f.outputSummary;
          run.durationMs = f.durationMs;
          // Light up this run's payroll row (§7.3B); absent on cost-less frames.
          run.role = f.role ?? null;
          run.model = f.model ?? null;
          run.usage = f.usage ?? null;
          run.cost = f.cost ?? null;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "completed";
          agent.currentRunId = null;
          agent.toolProgress = null;
        }
        break;
      }
      case "plan_review_required": {
        // 结构化挂起 2a: the scheduler paused after these step(s) completed; mark
        // them pending so the node shows a「待放行」badge.
        checkpointSteps.set(f.checkpointId, f.runIds);
        for (const id of f.runIds) {
          const run = runById(id);
          if (run) run.checkpoint = { status: "pending", decision: null };
        }
        break;
      }
      case "plan_review_resolved": {
        for (const id of checkpointSteps.get(f.checkpointId) ?? []) {
          const run = runById(id);
          if (run) {
            run.checkpoint = { status: "resolved", decision: f.decision };
          }
        }
        break;
      }
      case "plan_revised": {
        // 「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound / re-steered the
        // paused plan via replan. Tag each affected node so it paints a non-interrupting
        // trace (bind=据上游证据定稿待绑定步骤; steer=偏离后操舵未跑步骤). bind wins over steer
        // if a node is both. A stray run_id (not on this graph) is ignored.
        for (const rev of f.revisions) {
          const run = runById(rev.runId);
          if (
            run &&
            !(run.revised === "bind" && rev.revisionKind === "steer")
          ) {
            run.revised = rev.revisionKind;
          }
        }
        break;
      }
      case "run_failed": {
        const run = runById(f.runId);
        if (run) {
          run.status = "failed";
          run.error = f.error;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "error";
          agent.toolProgress = null;
        }
        break;
      }
      case "run_progress": {
        // Progress is derived from run states below so it stays correct and
        // cumulative across multiple delegate batches (the per-batch wire
        // counters would reset). The frame is kept only as a timeline marker.
        break;
      }
      case "run_escalation": {
        // 升级实时可见 (非阻塞): a worker flagged a decision/blocker for the CEO — append it
        // to its run so the node shows a ⚠️ badge and the card raises a live notice the
        // instant it fires (the durable copy still rides RunState.escalations → CEO
        // synthesis). A stray frame whose run isn't on this graph is ignored.
        const run = runById(f.runId);
        if (run)
          run.escalations.push({
            // Non-blocking banner: no resolve target (it never suspended).
            id: null,
            question: f.question,
            assumption: f.assumption,
            blocking: f.blocking,
            status: "raised",
            answer: null,
          });
        break;
      }
      case "escalation_required": {
        // 阻塞式求决策: a worker SUSPENDED on a blocking escalate, awaiting the user — append
        // a `pending` card to its run (the turn does NOT pause; siblings keep running). Twin
        // of the run_escalation banner but journaled, so it replays on reload.
        const run = runById(f.runId);
        if (run)
          run.escalations.push({
            // The interaction id the live card resolves against (carried by the journaled
            // escalation_required, so it survives a reload too).
            id: f.escalationId,
            question: f.question,
            assumption: f.assumption,
            blocking: true,
            status: "pending",
            answer: null,
          });
        break;
      }
      case "escalation_resolved": {
        // 阻塞式求决策 settlement: flip this run's pending escalation to resolved/timeout (a
        // worker is sequential ⇒ at most one pending per run, 设计 §4.7). `resolved` carries
        // the answer; `timeout` (含按假设继续) falls back to the assumption (answer stays null).
        const run = runById(f.runId);
        const esc = run?.escalations.find((e) => e.status === "pending");
        if (esc) {
          if (f.status === "resolved") {
            esc.status = "resolved";
            esc.answer = f.answer;
          } else {
            esc.status = "timeout";
            esc.answer = null;
          }
        }
        break;
      }
      case "tool_use_start": {
        // Tool events are not run-scoped on the wire; attach to whichever run
        // is running at this point in the fold (matches prior live behaviour).
        const running = runs.find((s) => s.status === "running");
        const agent = running ? agentById(running.agentId) : undefined;
        if (agent) {
          agent.toolCalls.push({
            id: f.toolCallId,
            toolName: f.toolName,
            arguments: f.arguments,
            result: null,
            status: "running",
          });
          // The call's arguments finished assembling and it is now executing, so
          // the「正在生成」progress line gives way to this real tool-call row.
          agent.toolProgress = null;
        }
        break;
      }
      case "tool_use_end": {
        for (const agent of agents) {
          const tc = agent.toolCalls.find((t) => t.id === f.toolCallId);
          if (tc) {
            tc.result = f.result;
            tc.display = f.display ?? null;
            tc.status = f.status;
            break;
          }
        }
        break;
      }
    }
  }

  // A stopped turn never receives terminal run frames for its in-flight nodes;
  // freeze them as cancelled so the card leaves its live state (no spinners /
  // progress bar) instead of looking like it is still running.
  if (status === "cancelled") {
    for (const s of runs) if (s.status === "running") s.status = "cancelled";
    for (const a of agents) if (a.status === "working") a.status = "cancelled";
  }

  return {
    id: plan.id,
    planType: plan.planType,
    taskSummary: plan.taskSummary,
    status,
    agents,
    runs,
    // Derived (not from run_progress): count terminal-completed nodes over the
    // cumulative run set, so multi-batch delegate progress is always correct.
    progress: {
      completed: runs.filter((s) => s.status === "completed").length,
      total: runs.length,
    },
    debate,
    debateRounds,
  };
}

/** Human-readable label for a frame, used by the timeline scrubber. */
export function describeFrame(frame: RunFrame, plan: ExecutionPlan): string {
  const role = (agentId: string) =>
    plan.agents.find((a) => a.id === agentId)?.role ?? agentId;
  const task = (runId: string) =>
    plan.runs.find((s) => s.id === runId)?.task ?? runId;

  switch (frame.kind) {
    case "run_started":
      return `${role(frame.agentId)} 开始 · ${task(frame.runId)}`;
    case "run_context":
      return `${task(frame.runId)} · 收到上下文`;
    case "run_output_delta":
      return `${role(frame.agentId)} 输出中…`;
    case "run_reasoning_delta":
      return `${role(frame.agentId)} 思考中…`;
    case "run_tool_progress":
      return `${role(frame.agentId)} 生成 ${toolLabel(frame.toolName)}…`;
    case "run_completed":
      return `${role(frame.agentId)} 完成`;
    case "run_failed":
      return `${role(frame.agentId)} 失败`;
    case "run_progress":
      return `进度 ${frame.completed}/${frame.total}`;
    case "run_escalation":
      return `${role(frame.agentId)} 上报问题`;
    case "escalation_required":
      return `${role(frame.agentId)} 求决策 · 待你拍板`;
    case "escalation_resolved":
      return frame.status === "resolved"
        ? `${role(frame.agentId)} 已获答复 · 继续`
        : `${role(frame.agentId)} 按假设继续`;
    case "tool_use_start":
      return `调用工具 ${frame.toolName}`;
    case "tool_use_end":
      return `工具${frame.status === "success" ? "完成" : "失败"}`;
    case "plan_review_required":
      return "执行暂停 · 待你放行";
    case "plan_review_resolved":
      return frame.decision === "stop"
        ? "已停止 · 未运行下游"
        : "已放行 · 继续";
    case "plan_revised": {
      const bound = frame.revisions.filter(
        (r) => r.revisionKind === "bind",
      ).length;
      const steered = frame.revisions.filter(
        (r) => r.revisionKind === "steer",
      ).length;
      const parts: string[] = [];
      if (bound) parts.push(`定稿 ${bound}`);
      if (steered) parts.push(`操舵 ${steered}`);
      return `计划已调整 · ${parts.join(" · ")}`;
    }
  }
}

/**
 * Wall-clock span covered by a frame stream, in ms (0 if fewer than 2 frames).
 *
 * Used for the completed task card's "用时" summary. Wall-clock (last − first
 * frame timestamp) is correct regardless of parallelism, unlike summing
 * per-run durations which would overcount concurrent agents.
 */
export function elapsedMs(frames: RunFrame[]): number {
  if (frames.length < 2) return 0;
  return Math.max(0, frames[frames.length - 1].t - frames[0].t);
}
