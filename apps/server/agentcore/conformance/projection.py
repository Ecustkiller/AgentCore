"""The ProjectedTurn oracle: fold an SSE event vector → the normalized judge state.

This is the backend-authoritative twin of the frontend folds (mobile
``src/protocol/fold.ts``; desktop ``stores/execution.ts`` + ``streamConversation``).
Its output IS the golden every端 must match (前端技术与架构 §十二).

Semantics are deliberately a port of the two PROVEN frontend/runtime projections, so
the oracle never invents behavior the product doesn't already have:

- the multi-agent team graph (agents / runs / progress) mirrors desktop
  ``projectExecution`` (run_plan skeleton → run_* frames fold in; progress derived
  from run states; revisions synthesized from their run_started frame);
- the 思考·正文·工具·协作 ``process`` timeline mirrors ``EventSink._accumulate_process``
  (reasoning/content deltas coalesce; one step per captain tool call resolved by its
  tool_use_end; zero-width positional markers — ``team`` at run_plan, ``checkpoint`` /
  ``ask`` / ``plan_review`` at their *_required — fix where the graph / interaction
  cards render in chronological order; orchestration tool steps are dropped, the
  ``team`` marker stands in), carried for single-agent AND multi-agent turns (统一团队
  时间线 — the CEO's own steps), parity with ``process_timeline()`` (which only goes
  None for a turn with no structural step);
- ``content`` / ``reasoning`` accumulate the captain bubble's deltas (present even in
  a multi-agent turn — the CEO speaks above the graph);
- ``status`` / ``interactions[]`` fold the gate state machine (a gate *_required pauses,
  its *_resolved resumes when no gate remains pending; a paused turn's stream may end
  at the *_required). Full interaction lifecycle (pending|resolved|orphaned) is projected
  via :func:`fold_interactions` (runtime journal fold — single implementation);
- ``cost`` / ``finishReason`` come from message_end (回合总账).

Output keys are the camelCase ProjectedTurn shape (see
``packages/protocol-conformance/src/projectedTurn.ts``); wire-shaped leaves
(usage / cost / tool arguments / process step) are carried verbatim (snake_case kept).
"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.journal_config import cap_process_result
from agentcore.runtime.events.sink import ORCHESTRATION_TOOLS
from agentcore.runtime.journal.pending_interactions import (
    GATE_KINDS,
    fold_interactions,
    project_interaction_leaf,
)

# message_end.finish_reason → terminal TurnStatus (parity with desktop statusFromFinish,
# extended with the non-error completed reasons the chat turn can carry).
_FINISH_TO_STATUS: dict[str, str] = {
    "end_turn": "completed",
    "max_rounds": "completed",
    "degraded": "completed",
    "unproductive": "completed",
    "error": "failed",
    "cancelled": "cancelled",
    # Crash / lease-sweeper salvage (流式回复持久化 §3.4 / P4): incomplete turn kept as
    # cancelled-class terminal so the bubble offers retry, not a completed chip.
    "interrupted": "cancelled",
    # 挂起即收口 (②): a turn that ended AT a durable checkpoint (ask_user blocking /
    # plan_review) finalizes with finish_reason=paused — the stream carries a terminal
    # message_end yet the turn is NOT done. It must STAY paused (gate *_required already
    # parked interactions[]; message_end only adds finishReason + cost), so the resume
    # card renders, NOT a completed bubble. Without this the trailing message_end would
    # fall through to "completed" and erase the pause.
    "paused": "paused",
}


def _agent_from_plan(a: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": a.get("id", ""),
        "role": a.get("role", ""),
        "modelPreference": a.get("model_preference", "strong"),
        "thinking": bool(a.get("thinking", True)),
        "reasoningEffort": a.get("reasoning_effort", "high"),
        "status": "idle",
        "currentRunId": None,
        "output": "",
        "reasoning": "",
        "toolProgress": None,
    }


def _run_from_plan(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s.get("id", ""),
        "agentId": s.get("agent_id", ""),
        "task": s.get("task", ""),
        "status": "pending",
        "dependsOn": list(s.get("depends_on") or []),
        "outputSummary": None,
        # 完工交接简报: the worker's authored {summary/key_points/assumptions/next_steps},
        # set by run_completed; None until then (辩手 / trivial worker / captain carry none).
        "debrief": None,
        "durationMs": None,
        "error": None,
        "parentRunId": s.get("parent_run_id"),
        "kind": s.get("kind") or "agent",
        "role": None,
        "model": None,
        "usage": None,
        "cost": None,
        "stance": s.get("stance"),
        "group": s.get("group"),
        "round": s.get("round") or 0,
        "continuesRunId": None,
        # 「计划已调整」轻痕迹 (设计 §7.2): set by the plan_revised fact to "bind"/"steer" when
        # the CEO autonomously re-bound / re-steered this node mid-flight; None otherwise.
        "revised": None,
        # 回落换人: set from run_plan.replaces_run_id when CEO re-delegates after continue miss.
        "replacesRunId": s.get("replaces_run_id"),
        "checkpoint": None,
        # 收到的上下文 (上下文传递可视化): filled by the run_context fact; empty until then.
        "receivedContext": [],
        # 升级实时可见: appended by the run_escalation fact; empty until a worker escalates.
        "escalations": [],
        # Per-run 思考·正文·工具 timeline (对称 CEO process); empty until deltas/tools fold in.
        "process": [],
    }


def project_turn(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Fold an ordered SSE event vector into the normalized ProjectedTurn dict."""
    content = ""
    reasoning = ""
    # 收到的上下文 · CEO 侧 (上下文传递可视化): the captain run id (its kind=captain
    # run_started) + the structured opening context it was fed (system/history/request),
    # routed turn-level — the CEO is the bubble above the graph, not a peer node.
    captain_run_id: str | None = None
    captain_context: list[dict[str, Any]] = []
    process: list[dict[str, Any]] = []
    citations: list[dict[str, Any]] = []
    agents: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    plan_id: str | None = None
    finish_reason: str | None = None
    cost: dict[str, Any] | None = None
    saw_error = False
    # 辩论编排收场产物（debate_result）：整段 payload verbatim 折入，与 run_plan 的辩手
    # 节点互补（图承载执行/发言全文，本字段承载决策简报 + 交锋叙事线）。None=本回合无辩论。
    debate: dict[str, Any] | None = None
    # 本场是否开启质询（debate_round_started.cross_exam_enabled）：首轮开场即达；缺字段→False。
    cross_exam_enabled = False
    # 主持人开场白（debate_round_started.opening）：仅首轮携带；sticky 取第一个非空，不被后续覆盖。
    # 收场 debate.opening 仍是权威。缺字段 / 老 journal → None。
    debate_opening: str | None = None
    # 辩论逐轮叙事（debate_round_started / debate_round）：进行中实时叠加，折叠累积按 round_no
    # 升序。P2 DURABLE——落 journal，刷新后 hydrate/fold 重建；收场后全量叙事线亦在 debate。
    debate_rounds: list[dict[str, Any]] = []
    # 协调模式团队进展预览（team_synthesis_preview）：同 key 保最新。P2 DURABLE。
    team_synthesis_preview: dict[str, Any] | None = None
    # 预检警告（turn_warning）：P2 DURABLE。
    turn_warning: str | None = None
    # 团队便签墙 (§2.2 通): the batch's posted notes in chronological order. Journaled, so it
    # replays on reload (unlike transport-only board ops). Deduped by noteId for replay safety.
    team_notes: list[dict[str, Any]] = []
    # plan_review_resolved carries only the checkpoint id → remember the gated run ids.
    checkpoint_steps: dict[str, list[str]] = {}

    def agent_by_id(aid: str) -> dict[str, Any] | None:
        return next((a for a in agents if a["id"] == aid), None)

    def run_by_id(rid: str) -> dict[str, Any] | None:
        return next((r for r in runs if r["id"] == rid), None)

    def has_marker(kind: str, key: str, value: str) -> bool:
        """Whether a positional marker (team / checkpoint / ask / plan_review) for
        ``value`` is already in the timeline (multi-batch / replay dedup)."""
        return any(s.get("kind") == kind and s.get(key) == value for s in process)

    def upsert_round(entry: dict[str, Any]) -> None:
        """Fold one 逐轮叙事 update by ``round_no`` (a later debate_round overwrites the
        focus-only round_started entry — it carries focus too), kept ascending. Mirrors
        the TS folds' ``upsertDebateRound`` (conformance pins them equal)."""
        for i, r in enumerate(debate_rounds):
            if r["round_no"] == entry["round_no"]:
                debate_rounds[i] = entry
                return
        debate_rounds.append(entry)
        debate_rounds.sort(key=lambda r: r["round_no"])

    for ev in events:
        etype = ev.get("type") or ""
        p = ev.get("payload") or {}

        if etype == "content_delta":
            delta = p.get("delta") or ""
            content += delta
            if delta:
                if process and process[-1].get("kind") == "content":
                    process[-1]["text"] += delta
                else:
                    process.append({"kind": "content", "text": delta})

        elif etype == "content_reset":
            # 交付前核验回炉 (finish_guard)：done 轮草稿未过轻层核验，引擎丢弃这一版、发
            # content_reset、回炉重写。该事件进 _history（重连回放重发），故 oracle 必须与三端
            # fold 一致：清正文标量 + 弹掉 process 尾部连续 content 步（reasoning/tool 是真实
            # 过程，保留），让重写版从干净态重累积——否则会把「违规版+修正版」拼在一起。
            content = ""
            while process and process[-1].get("kind") == "content":
                process.pop()
            # 核验回炉轻 chip：大众可见痕迹，不堆被弃全文。
            process.append({"kind": "rework"})

        elif etype == "reasoning_delta":
            delta = p.get("delta") or ""
            reasoning += delta
            if delta:
                if process and process[-1].get("kind") == "reasoning":
                    process[-1]["text"] += delta
                else:
                    process.append({"kind": "reasoning", "text": delta})

        elif etype == "tool_use_start":
            # A delegated worker's call (run-scoped) belongs to its run node, not the
            # captain's inline timeline; an orchestration call (delegate/debate) is
            # represented by the `team` marker (dropped at run_plan), not a tool step.
            # Either way it creates no captain step (统一团队时间线 = the CEO's OWN steps);
            # still clear the run's live toolProgress below.
            rid = p.get("run_id") or ""
            if rid:
                run = run_by_id(rid)
                if run is not None:
                    run["process"].append(
                        {
                            "kind": "tool",
                            "id": p.get("tool_call_id", ""),
                            "tool_name": p.get("tool_name", ""),
                            "arguments": p.get("arguments") or {},
                            "result": None,
                            "status": "running",
                        }
                    )
            elif p.get("tool_name") not in ORCHESTRATION_TOOLS:
                step: dict[str, Any] = {
                    "kind": "tool",
                    "id": p.get("tool_call_id", ""),
                    "tool_name": p.get("tool_name", ""),
                    "arguments": p.get("arguments") or {},
                    "result": None,
                    "status": "running",
                }
                process.append(step)
            # Multi-agent: attach the executing call to the running run's agent too
            # (desktop attaches tool calls to whichever run is running). Captured on the
            # agent's currentRunId; worker tool fidelity beyond status is a later ratchet.
            running = next((r for r in runs if r["status"] == "running"), None)
            if running:
                ag = agent_by_id(running["agentId"])
                if ag:
                    ag["toolProgress"] = None

        elif etype == "tool_use_end":
            rid = p.get("run_id") or ""
            call_id = p.get("tool_call_id", "")
            result = cap_process_result(p.get("result"))
            display = p.get("display")
            if rid:
                run = run_by_id(rid)
                if run is not None:
                    for step in reversed(run["process"]):
                        if step.get("kind") == "tool" and step.get("id") == call_id:
                            step["result"] = result
                            step["status"] = p.get("status", "success")
                            if display is not None:
                                step["display"] = display
                            break
                continue
            if p.get("tool_name") in ORCHESTRATION_TOOLS:
                continue
            for step in reversed(process):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = p.get("status", "success")
                    if display is not None:
                        step["display"] = display
                    break

        elif etype == "citations":
            citations = list(p.get("citations") or [])

        elif etype == "run_plan":
            ip = p.get("execution_id")
            # 协作图时间线落点 (统一团队时间线): the first run_plan of an execution drops a
            # zero-width `team` marker at its chronological spot (later same-id batches merge
            # into one graph → one marker). Mirrors EventSink._accumulate_process.
            if ip and not has_marker("team", "execution_id", ip):
                process.append({"kind": "team", "execution_id": ip})
            if plan_id is None or plan_id == ip:
                plan_id = ip
                for a in p.get("agents") or []:
                    if not agent_by_id(a.get("id", "")):
                        agents.append(_agent_from_plan(a))
                for s in p.get("runs") or []:
                    if not run_by_id(s.get("id", "")):
                        runs.append(_run_from_plan(s))
            else:
                # A different execution id is a fresh plan (desktop resets the slot).
                plan_id = ip
                agents = [_agent_from_plan(a) for a in (p.get("agents") or [])]
                runs = [_run_from_plan(s) for s in (p.get("runs") or [])]

        elif etype == "run_started":
            rid = p.get("run_id", "")
            agid = p.get("agent_id", "")
            continues = p.get("continues_run_id")
            parent = p.get("parent_run_id")
            kind = p.get("kind") or "agent"
            # The CEO captain is the turn's root (kind=captain); remember its run id so its
            # run_context routes turn-level. The captain node itself comes from run_plan (or
            # is dropped on a non-delegating turn) — this only tracks the id.
            if kind == "captain":
                captain_run_id = rid
            run = run_by_id(rid)
            # 同人续派 / 热修 / 辩论续写: not in the plan — synthesize off the session root.
            if run is None and continues:
                original = run_by_id(continues)
                if original is not None:
                    origin_agent = agent_by_id(original["agentId"])
                    agents.append(
                        {
                            "id": agid,
                            "role": origin_agent["role"] if origin_agent else original["agentId"],
                            "modelPreference": origin_agent["modelPreference"]
                            if origin_agent
                            else "strong",
                            "thinking": origin_agent["thinking"] if origin_agent else True,
                            "reasoningEffort": origin_agent["reasoningEffort"]
                            if origin_agent
                            else "high",
                            "status": "idle",
                            "currentRunId": None,
                            "output": "",
                            "reasoning": "",
                            "toolProgress": None,
                        }
                    )
                    run = {
                        **_run_from_plan({"id": rid, "agent_id": agid, "task": original["task"]}),
                        "parentRunId": parent,
                        "kind": kind,
                        "continuesRunId": continues,
                        # 乙 wire 携 round/stance：debate 续写从 wire 读身份与轮次。
                        "stance": p.get("stance"),
                        "group": p.get("group"),
                        "round": p.get("round") or 0,
                    }
                    runs.append(run)
            if run is not None:
                run["status"] = "running"
                run["parentRunId"] = parent
                run["kind"] = kind
                if continues:
                    run["continuesRunId"] = continues
                # 冷回落接手: mid-flight `_redir` carries replaces_run_id on the wire.
                replaces = p.get("replaces_run_id")
                if replaces:
                    run["replacesRunId"] = replaces
            ag = agent_by_id(agid)
            if ag:
                ag["status"] = "working"
                ag["currentRunId"] = rid
                ag["toolProgress"] = None

        elif etype == "run_context":
            # 收到的上下文 (上下文传递可视化): the structured context this run was fed, carried
            # verbatim (wire-shaped snake_case blocks) — the same data the LLM saw. The
            # CAPTAIN's (kind=captain) routes TURN-LEVEL onto captainContext (the CEO is the
            # bubble above the graph, not a node — so it shows on every turn, pure chat
            # included), APPENDING across emits so its context GROWS by each post-delegation
            # team readback (通道⑤); a WORKER's folds onto its graph node. Mirrors the
            # desktop/mobile folds (conformance pins them equal).
            rid = p.get("run_id", "")
            if rid and rid == captain_run_id:
                captain_context.extend(p.get("blocks") or [])
            else:
                run = run_by_id(rid)
                if run is not None:
                    run["receivedContext"] = list(p.get("blocks") or [])

        elif etype == "run_output_delta":
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["output"] += p.get("delta") or ""
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                delta = p.get("delta") or ""
                if delta:
                    steps = run["process"]
                    if steps and steps[-1].get("kind") == "content":
                        steps[-1]["text"] += delta
                    else:
                        steps.append({"kind": "content", "text": delta})

        elif etype == "run_output_reset":
            # 交付前核验回炉 (finish_guard) 的 worker 对偶（content_reset 之于 CEO）：worker done
            # 轮草稿未过轻层核验（统一底线·结构完整性），引擎丢弃这一版、发 run_output_reset、回炉
            # 重写。清该 agent 的 output 标量（重写版从干净态重累积），reasoning 是真实过程、保留
            # ——否则会把「违规版+修正版」拼在一起。transport-only（不进 journal），
            # 与三端 fold 一致。
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["output"] = ""
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                steps = run["process"]
                while steps and steps[-1].get("kind") == "content":
                    steps.pop()
                steps.append({"kind": "rework"})

        elif etype == "run_reasoning_delta":
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["reasoning"] += p.get("delta") or ""
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                delta = p.get("delta") or ""
                if delta:
                    steps = run["process"]
                    if steps and steps[-1].get("kind") == "reasoning":
                        steps[-1]["text"] += delta
                    else:
                        steps.append({"kind": "reasoning", "text": delta})

        elif etype == "run_tool_progress":
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["toolProgress"] = {
                    "toolName": p.get("tool_name", ""),
                    "chars": p.get("chars", 0),
                }

        elif etype == "run_completed":
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["status"] = "completed"
                run["outputSummary"] = p.get("output_summary")
                # 完工交接简报: verbatim structured brief when the worker authored one (else absent
                # → stays None), so the run-detail 摘要 shows the author's own wrap-up.
                run["debrief"] = p.get("debrief")
                run["durationMs"] = p.get("duration_ms")
                run["role"] = p.get("role")
                run["model"] = p.get("model")
                run["usage"] = p.get("usage")
                run["cost"] = p.get("cost")
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["status"] = "completed"
                ag["currentRunId"] = None
                ag["toolProgress"] = None

        elif etype == "run_failed":
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["status"] = "failed"
                run["error"] = p.get("error")
                # 完工交接简报 on a failed run: the author's wrap-up when a contract-missing
                # worker still produced one (else absent → stays None).
                run["debrief"] = p.get("debrief")
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["status"] = "error"
                ag["toolProgress"] = None

        elif etype == "run_cancelled":
            # 跑一半改方向 / 整轮停止: interrupt mid-flight (orthogonal to run_failed).
            # reason=redirect → single-worker hard-stop (hot continue_run / cold _redir may
            # follow); reason=stop → whole-turn abort. Clear currentRunId + toolProgress so
            # the node leaves its live「正在生成」line (reload-safe).
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["status"] = "cancelled"
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["status"] = "cancelled"
                ag["currentRunId"] = None
                ag["toolProgress"] = None

        elif etype == "run_skipped":
            # 级联跳过 / graceful abort: node never ran — materialised SKIPPED so the graph
            # shows「未执行」instead of forever-pending. Orthogonal to run_cancelled.
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["status"] = "skipped"
            # Agent never started — leave idle (no currentRunId / toolProgress to clear).

        elif etype == "run_progress":
            # Progress is derived from run states below (cumulative, multi-batch safe);
            # the wire counter is a timeline marker only.
            pass

        elif etype == "plan_revised":
            # 「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound / re-steered the
            # paused plan via replan. Fold each affected node's kind onto its run so every end
            # paints a non-interrupting trace (mirrors the desktop/mobile folds; conformance
            # pins them equal). A stray run_id (not on this graph) is ignored.
            for rev in p.get("revisions") or []:
                run = run_by_id(rev.get("run_id", ""))
                if run is not None:
                    run["revised"] = rev.get("kind")

        elif etype == "run_escalation":
            # 升级实时可见 (非阻塞): a worker flagged a decision/blocker for the CEO — append
            # it to its run so the node carries a ⚠️ badge (mirrors the desktop/mobile folds,
            # conformance pins them equal). Transport-only on the wire; the durable copy
            # rides RunState.escalations → CEO synthesis. Status stays "raised" (the worker
            # kept working — today's behaviour).
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["escalations"].append(
                    {
                        "question": p.get("question", ""),
                        "assumption": p.get("assumption", ""),
                        "blocking": bool(p.get("blocking")),
                        "status": "raised",
                        "answer": None,
                        "kind": p.get("kind") or "normal",
                    }
                )

        elif etype == "escalation_required":
            # 阻塞式求决策: a worker SUSPENDED on a blocking escalate — append a "pending"
            # card to its run. The turn does NOT pause (siblings keep running), so unlike
            # the halting gates this sets no `pending` interaction.
            # ``awaiting=ceo`` is projected; classic user path omits (default).
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                awaiting = p.get("awaiting") or "user"
                if awaiting not in ("user", "ceo"):
                    awaiting = "user"
                entry: dict = {
                    "question": p.get("question", ""),
                    "assumption": p.get("assumption", ""),
                    "blocking": True,
                    "status": "pending",
                    "answer": None,
                    "kind": p.get("kind") or "normal",
                }
                if awaiting == "ceo":
                    entry["awaiting"] = "ceo"
                run["escalations"].append(entry)

        elif etype == "escalation_resolved":
            # Settlement: flip this run's pending escalation. Wire status is
            # resolved | assumed | timed_out. Projected RunEscalation keeps
            # assumed/timed_out distinct; both leave answer null.
            run = run_by_id(p.get("run_id", ""))
            esc = (
                next((e for e in run["escalations"] if e.get("status") == "pending"), None)
                if run is not None
                else None
            )
            if esc is not None:
                raw = p.get("status")
                if raw == "resolved":
                    esc["status"] = "resolved"
                    esc["answer"] = p.get("answer", "")
                elif raw == "assumed":
                    esc["status"] = "assumed"
                    esc["answer"] = None
                else:
                    esc["status"] = "timed_out"
                    esc["answer"] = None
                if p.get("arbitrated_by") == "ceo":
                    esc["arbitrated_by"] = "ceo"
                    if "via_user" in p:
                        esc["via_user"] = bool(p.get("via_user"))

        elif etype == "debate_result":
            # 一场辩论收场：整段结构化产物（form/motion/rounds/brief/sides/各方 run_id）
            # verbatim 存入，前端辩论视图据此取简报 + 叙事线，从执行图辩手节点取发言全文。
            debate = p

        elif etype == "debate_round_started":
            # 一轮开场（发言前）：先给焦点，verdict=None 表示该轮进行中（仅定焦点未裁判，
            # clashes 恒空——交锋边由裁判步产出；cross_exam 恒空——质询 beat 尚未开始）。
            # 同事件权威声明本场是否开质询（缺字段→保持 False，向后兼容老 journal）。
            # opening 仅首轮非空：sticky 取第一个非空，不被后续轮空串覆盖。
            if p.get("cross_exam_enabled") is True:
                cross_exam_enabled = True
            raw_opening = (p.get("opening") or "").strip()
            if raw_opening and not debate_opening:
                debate_opening = raw_opening
            upsert_round(
                {
                    "round_no": p.get("round_no", 0),
                    "focus": p.get("focus", ""),
                    "summary": "",
                    "verdict": None,
                    "sides": [],
                    "clashes": [],
                    "cross_exam": [],
                }
            )

        elif etype == "debate_round":
            # 一轮收尾（裁判+小结后）：焦点/小结/裁判/各方→辩手 run_id 映射/L3 交锋边/质询问答。
            upsert_round(
                {
                    "round_no": p.get("round_no", 0),
                    "focus": p.get("focus", ""),
                    "summary": p.get("summary", ""),
                    "verdict": p.get("verdict"),
                    "sides": list(p.get("sides") or []),
                    "clashes": list(p.get("clashes") or []),
                    "cross_exam": list(p.get("cross_exam") or []),
                }
            )

        elif etype == "team_note_posted":
            # 团队便签墙 (§2.2 通): a worker broadcast a one-line decision / heads-up to its
            # concurrent siblings. Fold it onto the turn's teamNotes (chronological), deduped by
            # noteId for replay safety (mirrors the desktop/mobile folds; conformance pins them
            # equal). The wall is engine-scoped; the panel just lists the turn's notes.
            note_id = p.get("note_id", "")
            supersedes = p.get("supersedes")
            if not any(n.get("noteId") == note_id for n in team_notes):
                team_notes.append(
                    {
                        "noteId": note_id,
                        "runId": p.get("run_id", ""),
                        "agentId": p.get("agent_id", ""),
                        "role": p.get("role", ""),
                        "kind": p.get("kind", ""),
                        "text": p.get("text", ""),
                        "ts": p.get("ts"),
                        # 便签会过期 → supersession (§2.2): a fresh note is active; this fold marks
                        # the TARGET stale below. `supersedes` is the note this one 改写/作废s (None
                        # for a fresh post) — kept so the panel can link an amendment to its origin.
                        "status": "active",
                        "supersedes": supersedes,
                    }
                )
                if p.get("source"):
                    team_notes[-1]["source"] = p["source"]
            # An amendment (carries `supersedes`) marks its TARGET superseded (改写) / voided
            # (作废) — `supersede_mode` is the single discriminator every fold shares. The target
            # was posted earlier, so it is already in the list (events replay in order).
            if supersedes:
                target = next((n for n in team_notes if n.get("noteId") == supersedes), None)
                if target is not None:
                    target["status"] = (
                        "voided" if p.get("supersede_mode") == "void" else "superseded"
                    )

        elif etype == "approval_required":
            # Gate lifecycle → fold_interactions at end; only turn-status side effects
            # lived here historically. Process markers N/A for approval.
            pass

        elif etype in (
            "approval_resolved",
            "delegation_authorization_required",
            "delegation_authorization_resolved",
        ):
            pass

        elif etype == "checkpoint_required":
            cid = p.get("checkpoint_id", "")
            # ask_user 正文吸收：same-round prose folds into the card — drop bubble text
            # so a streamed lead-in never duplicates the checkpoint card on replay.
            content = ""
            while process and process[-1].get("kind") == "content":
                process.pop()
            # 检查点时间线落点: positional marker so the card replays at its real spot
            # (card body folds separately, keyed by id). Mirrors EventSink.
            if cid and not has_marker("checkpoint", "checkpoint_id", cid):
                process.append({"kind": "checkpoint", "checkpoint_id": cid})

        elif etype == "checkpoint_resolved":
            pass

        elif etype == "plan_review_required":
            cid = p.get("checkpoint_id", "")
            # 计划复核时间线落点: positional marker (card body folds separately).
            if cid and not has_marker("plan_review", "checkpoint_id", cid):
                process.append({"kind": "plan_review", "checkpoint_id": cid})
            run_ids = [s.get("run_id", "") for s in (p.get("steps") or [])]
            checkpoint_steps[cid] = run_ids
            for rid in run_ids:
                run = run_by_id(rid)
                if run is not None:
                    run["checkpoint"] = {"status": "pending", "decision": None}

        elif etype == "plan_review_resolved":
            cid = p.get("checkpoint_id", "")
            for rid in checkpoint_steps.get(cid, []):
                run = run_by_id(rid)
                if run is not None:
                    run["checkpoint"] = {
                        "status": "resolved",
                        "decision": p.get("decision"),
                    }

        elif etype == "team_preview_required":
            # Event order is run_plan → team_preview_required, but product narrative is
            # 开工卡 → 协作图 — insert before the last team marker when one exists.
            cid = p.get("checkpoint_id", "")
            if cid and not has_marker("team_preview", "checkpoint_id", cid):
                marker = {"kind": "team_preview", "checkpoint_id": cid}
                for i in range(len(process) - 1, -1, -1):
                    if process[i].get("kind") == "team":
                        process.insert(i, marker)
                        break
                else:
                    process.append(marker)

        elif etype == "team_preview_resolved":
            pass

        elif etype == "question_posted":
            # 非阻塞发问时间线落点: the CEO surfaced a question and kept working (no gate) —
            # positional marker only; interactions[] carries the card body by ask_id.
            aid = p.get("ask_id", "")
            if aid and not has_marker("ask", "ask_id", aid):
                process.append({"kind": "ask", "ask_id": aid})

        elif etype == "error":
            saw_error = True

        elif etype == "message_end":
            finish_reason = p.get("finish_reason")
            cost = p.get("cost")

        elif etype == "turn_warning":
            msg = p.get("message")
            if isinstance(msg, str) and msg.strip():
                turn_warning = msg

        elif etype == "team_synthesis_preview":
            # 同 key 保最新（后写覆盖）。
            team_synthesis_preview = p

        else:
            # message_start / turn_saved / title_generated / followups_generated /
            # board_op_required / board_read_required / desktop_notify_required /
            # tool_progress / workspace_op_required /
            # handoff_* /
            # interaction_orphaned / escalation_* (run escalations folded above) —
            # not part of the normalized turn judge state beyond interactions[] fold
            # (no-op here). Mirrored by the frontend folds' assertNever switch
            # so the set stays in lockstep.
            pass

    # Interactions[] — single fold implementation (runtime pending_interactions).
    interactions = [
        project_interaction_leaf(rec) for rec in fold_interactions(events)
    ]
    gate_pending = any(
        i.get("status") == "pending" and i.get("kind") in GATE_KINDS for i in interactions
    )
    if finish_reason is not None:
        status = _FINISH_TO_STATUS.get(finish_reason or "", "completed")
    elif saw_error:
        status = "failed"
    elif gate_pending:
        status = "paused"
    else:
        status = "running"

    # A cancelled OR failed turn may leave in-flight nodes with no terminal frame; freeze
    # them as cancelled (parity with projectExecution's freeze pass). The cancelled case is
    # the graceful one (workers get run_cancelled). The failed case is the defensive one: a
    # turn that errors out (hard crash / lost terminal frame) while a worker is still
    # in-flight would otherwise replay that node as a forever-spinning "running" on reload —
    # 避免假 working must cover the failed outcome too, not just the stop.
    if status in ("cancelled", "failed"):
        for r in runs:
            if r["status"] == "running":
                r["status"] = "cancelled"
        for a in agents:
            if a["status"] == "working":
                a["status"] = "cancelled"

    # Turn terminal (completed / cancelled / failed): any plan-declared node that never got
    # a terminal run frame (old journals without run_skipped, or a grant-then-end vector)
    # closes as skipped —「未执行」instead of forever「排队中」. Live streams emit run_skipped
    # at wave close; this is the journal-compat / defensive finalize pass.
    if status in ("completed", "cancelled", "failed"):
        for r in runs:
            if r["status"] == "pending":
                r["status"] = "skipped"

    return {
        "status": status,
        "finishReason": finish_reason,
        "content": content,
        "reasoning": reasoning,
        # 收到的上下文 · CEO 侧 (上下文传递可视化, 通道①): turn-level, present on every turn the
        # captain emitted run_context for (pure chat included), [] otherwise.
        "captainContext": captain_context,
        # The CEO's inline timeline — carried for single-agent AND multi-agent turns
        # (统一团队时间线): besides reasoning/content/tool steps it carries zero-width
        # POSITIONAL MARKERS — `team` (the collaboration graph slot, dropped at run_plan),
        # `checkpoint` / `ask` / `plan_review` (interaction cards) — fixing where each
        # non-text element renders in chronological order, worker activity rides
        # `runs`/`agents`. A pure reasoning/content turn builds no structural step (the
        # live persist gate then stores no process, matching the fold).
        "process": process,
        "citations": citations,
        "agents": agents,
        "runs": runs,
        "progress": {
            "completed": sum(1 for r in runs if r["status"] == "completed"),
            "total": len(runs),
        },
        "interactions": interactions,
        "cost": cost,
        "debate": debate,
        "debateRounds": debate_rounds,
        "crossExamEnabled": cross_exam_enabled,
        "debateOpening": debate_opening,
        "teamSynthesisPreview": team_synthesis_preview,
        "turnWarning": turn_warning,
        # 团队便签墙 (§2.2 通): the turn's posted notes (chronological), [] when none.
        "teamNotes": team_notes,
    }
