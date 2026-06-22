"""The ProjectedTurn oracle: fold an SSE event vector → the normalized judge state.

This is the backend-authoritative twin of the frontend folds (mobile
``src/protocol/fold.ts``; desktop ``stores/execution.ts`` + ``streamConversation``).
Its output IS the golden every端 must match (前端技术与架构 §十二).

Semantics are deliberately a port of the two PROVEN frontend/runtime projections, so
the oracle never invents behavior the product doesn't already have:

- the multi-agent team graph (agents / runs / progress) mirrors desktop
  ``projectExecution`` (run_plan skeleton → run_* frames fold in; progress derived
  from run states; revisions synthesized from their run_started frame);
- the 思考·正文·工具 ``process`` timeline mirrors ``EventSink._accumulate_process``
  (reasoning/content deltas coalesce; one step per tool call resolved by its
  tool_use_end), carried for single-agent AND multi-agent turns (统一团队时间线 — the
  CEO's own steps, with the ``delegate`` step marking the team-graph slot), parity
  with ``process_timeline()`` (which only goes None for a tool-less turn);
- ``content`` / ``reasoning`` accumulate the captain bubble's deltas (present even in
  a multi-agent turn — the CEO speaks above the graph);
- ``status`` / ``pendingInteraction`` fold the gate state machine (a *_required pauses,
  its *_resolved resumes; a paused turn's stream simply ends at the *_required);
- ``cost`` / ``finishReason`` come from message_end (回合总账).

Output keys are the camelCase ProjectedTurn shape (see
``packages/protocol-conformance/src/projectedTurn.ts``); wire-shaped leaves
(usage / cost / tool arguments / process step) are carried verbatim (snake_case kept).
"""

from __future__ import annotations

from typing import Any

# message_end.finish_reason → terminal TurnStatus (parity with desktop statusFromFinish,
# extended with the non-error completed reasons the chat turn can carry).
_FINISH_TO_STATUS: dict[str, str] = {
    "end_turn": "completed",
    "max_rounds": "completed",
    "degraded": "completed",
    "unproductive": "completed",
    "error": "failed",
    "cancelled": "cancelled",
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
        "revisionOf": None,
        "revision": 0,
        # 「计划已调整」轻痕迹 (设计 §7.2): set by the plan_revised fact to "bind"/"steer" when
        # the CEO autonomously re-bound / re-steered this node mid-flight; None otherwise.
        "revised": None,
        "checkpoint": None,
        # 收到的上下文 (上下文传递可视化): filled by the run_context fact; empty until then.
        "receivedContext": [],
        # 升级实时可见: appended by the run_escalation fact; empty until a worker escalates.
        "escalations": [],
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
    status = "running"
    finish_reason: str | None = None
    cost: dict[str, Any] | None = None
    pending: dict[str, Any] | None = None
    # 辩论编排收场产物（debate_result）：整段 payload verbatim 折入，与 run_plan 的辩手
    # 节点互补（图承载执行/发言全文，本字段承载决策简报 + 交锋叙事线）。None=本回合无辩论。
    debate: dict[str, Any] | None = None
    # 辩论逐轮叙事（debate_round_started / debate_round）：进行中实时叠加，折叠累积按 round_no
    # 升序。transport-only 事件 → 重载（journal 无之）恒为 []，届时全量叙事线在 debate 里。
    debate_rounds: list[dict[str, Any]] = []
    # plan_review_resolved carries only the checkpoint id → remember the gated run ids.
    checkpoint_steps: dict[str, list[str]] = {}

    def agent_by_id(aid: str) -> dict[str, Any] | None:
        return next((a for a in agents if a["id"] == aid), None)

    def run_by_id(rid: str) -> dict[str, Any] | None:
        return next((r for r in runs if r["id"] == rid), None)

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
            # captain's inline timeline — keep it out of `process` (统一团队时间线 = the
            # CEO's OWN steps); still clear the run's live toolProgress below.
            if not p.get("run_id"):
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
            if p.get("run_id"):
                continue
            call_id = p.get("tool_call_id", "")
            result = p.get("result")
            display = p.get("display")
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
            revision = p.get("revision") or 0
            parent = p.get("parent_run_id")
            kind = p.get("kind") or "agent"
            # The CEO captain is the turn's root (kind=captain); remember its run id so its
            # run_context routes turn-level. The captain node itself comes from run_plan (or
            # is dropped on a non-delegating turn) — this only tracks the id.
            if kind == "captain":
                captain_run_id = rid
            run = run_by_id(rid)
            # 定向唤回 续写 (乙 热修 P4): a revision (>=2) is not in the plan — synthesize
            # it off the original, mirroring projectExecution.
            if run is None and revision and parent:
                original = run_by_id(parent)
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
                        "revisionOf": parent,
                        "revision": revision,
                    }
                    runs.append(run)
            if run is not None:
                run["status"] = "running"
                run["parentRunId"] = parent
                run["kind"] = kind
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

        elif etype == "run_reasoning_delta":
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["reasoning"] += p.get("delta") or ""

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
            ag = agent_by_id(p.get("agent_id", ""))
            if ag:
                ag["status"] = "error"
                ag["toolProgress"] = None

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
                    }
                )

        elif etype == "escalation_required":
            # 阻塞式求决策: a worker SUSPENDED on a blocking escalate, awaiting the user —
            # append a "pending" card to its run. The turn does NOT pause (siblings keep
            # running), so unlike the halting gates this sets no `pending` interaction.
            # Journaled twin of the run_escalation banner, so it replays on reload.
            run = run_by_id(p.get("run_id", ""))
            if run is not None:
                run["escalations"].append(
                    {
                        "question": p.get("question", ""),
                        "assumption": p.get("assumption", ""),
                        "blocking": True,
                        "status": "pending",
                        "answer": None,
                    }
                )

        elif etype == "escalation_resolved":
            # 阻塞式求决策 settlement: flip this run's pending escalation to resolved/timeout
            # (a worker is sequential ⇒ at most one pending per run, 设计 §4.7). "resolved"
            # carries the answer; "timeout" (含按假设继续) falls back to the assumption
            # (answer stays None). Single-emitter: only the suspending tool sends this.
            run = run_by_id(p.get("run_id", ""))
            esc = (
                next((e for e in run["escalations"] if e.get("status") == "pending"), None)
                if run is not None
                else None
            )
            if esc is not None:
                if p.get("status") == "resolved":
                    esc["status"] = "resolved"
                    esc["answer"] = p.get("answer", "")
                else:
                    esc["status"] = "timeout"
                    esc["answer"] = None

        elif etype == "debate_result":
            # 一场辩论收场：整段结构化产物（form/motion/rounds/brief/sides/各方 run_id）
            # verbatim 存入，前端辩论视图据此取简报 + 叙事线，从执行图辩手节点取发言全文。
            debate = p

        elif etype == "debate_round_started":
            # 一轮开场（发言前）：先给焦点，verdict=None 表示该轮进行中（仅定焦点未裁判，
            # clashes 恒空——交锋边由裁判步产出）。
            upsert_round(
                {
                    "round_no": p.get("round_no", 0),
                    "focus": p.get("focus", ""),
                    "summary": "",
                    "verdict": None,
                    "sides": [],
                    "clashes": [],
                }
            )

        elif etype == "debate_round":
            # 一轮收尾（裁判+小结后）：焦点/小结/裁判/各方→辩手 run_id 映射/L3 交锋边。
            upsert_round(
                {
                    "round_no": p.get("round_no", 0),
                    "focus": p.get("focus", ""),
                    "summary": p.get("summary", ""),
                    "verdict": p.get("verdict"),
                    "sides": list(p.get("sides") or []),
                    "clashes": list(p.get("clashes") or []),
                }
            )

        elif etype == "approval_required":
            pending = {
                "kind": "approval",
                "approvalId": p.get("approval_id", ""),
                "toolCallId": p.get("tool_call_id", ""),
                "toolName": p.get("tool_name", ""),
                "arguments": p.get("arguments") or {},
            }
            status = "paused"

        elif etype == "approval_resolved":
            if (
                pending
                and pending.get("kind") == "approval"
                and pending.get("approvalId") == p.get("approval_id")
            ):
                pending = None
                status = "running"

        elif etype == "checkpoint_required":
            pending = {
                "kind": "checkpoint",
                "checkpointId": p.get("checkpoint_id", ""),
                "question": p.get("question", ""),
                "context": p.get("context", ""),
            }
            status = "paused"

        elif etype == "checkpoint_resolved":
            if (
                pending
                and pending.get("kind") == "checkpoint"
                and pending.get("checkpointId") == p.get("checkpoint_id")
            ):
                pending = None
                status = "running"

        elif etype == "plan_review_required":
            cid = p.get("checkpoint_id", "")
            run_ids = [s.get("run_id", "") for s in (p.get("steps") or [])]
            checkpoint_steps[cid] = run_ids
            for rid in run_ids:
                run = run_by_id(rid)
                if run is not None:
                    run["checkpoint"] = {"status": "pending", "decision": None}
            pending = {"kind": "plan_review", "checkpointId": cid, "runIds": run_ids}
            status = "paused"

        elif etype == "plan_review_resolved":
            cid = p.get("checkpoint_id", "")
            for rid in checkpoint_steps.get(cid, []):
                run = run_by_id(rid)
                if run is not None:
                    run["checkpoint"] = {
                        "status": "resolved",
                        "decision": p.get("decision"),
                    }
            if pending and pending.get("kind") == "plan_review" and pending.get("checkpointId") == cid:
                pending = None
                status = "running"

        elif etype == "error":
            status = "failed"

        elif etype == "message_end":
            finish_reason = p.get("finish_reason")
            cost = p.get("cost")
            status = _FINISH_TO_STATUS.get(finish_reason or "", "completed")

        else:
            # message_start / turn_saved / title_generated / tool_progress /
            # question_posted (non-gating) / workspace_op_required / handoff_* —
            # not part of the normalized turn judge state (no-op). Mirrored by the
            # frontend folds' assertNever switch so the set stays in lockstep.
            pass

    # A cancelled turn never received terminal frames for in-flight nodes; freeze them
    # (parity with projectExecution's cancelled pass).
    if status == "cancelled":
        for r in runs:
            if r["status"] == "running":
                r["status"] = "cancelled"
        for a in agents:
            if a["status"] == "working":
                a["status"] = "cancelled"

    return {
        "status": status,
        "finishReason": finish_reason,
        "content": content,
        "reasoning": reasoning,
        # 收到的上下文 · CEO 侧 (上下文传递可视化, 通道①): turn-level, present on every turn the
        # captain emitted run_context for (pure chat included), [] otherwise.
        "captainContext": captain_context,
        # The CEO's inline timeline — carried for single-agent AND multi-agent turns
        # (统一团队时间线): a delegating turn's `delegate` step marks where the team graph
        # slots in at render, worker activity rides `runs`/`agents`. Tool-less turns
        # build no process (no interleaving to preserve), matching process_timeline().
        "process": process,
        "citations": citations,
        "agents": agents,
        "runs": runs,
        "progress": {
            "completed": sum(1 for r in runs if r["status"] == "completed"),
            "total": len(runs),
        },
        "pendingInteraction": pending,
        "cost": cost,
        "debate": debate,
        "debateRounds": debate_rounds,
    }
