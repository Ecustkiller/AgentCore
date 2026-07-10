"""CEO coordination tools: update_synthesis + cancel_worker + resolve_escalation."""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.coordination.session import active_coordination
from agentcore.runtime.events import team_synthesis_preview
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)


class UpdateSynthesisTool:
    """Update the progressive CEO synthesis draft and push ``team_synthesis_preview``."""

    def __init__(self, *, sink: Any) -> None:
        self._sink = sink

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="update_synthesis",
            description=(
                "【仅协调模式】更新你对团队进展的合成草稿（进展中，非终稿）。"
                "草稿会推给用户预览；全部完成后请用正文写出最终合成（content_delta），不要再用本工具。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "draft": {
                        "type": "string",
                        "description": "当前合成草稿全文（会覆盖上一版）。",
                    },
                },
                "required": ["draft"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        session = active_coordination(context.execution_id)
        if session is None or not session.active:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="当前不在协调模式——仅在协调模式启动团队后可用（≥2 worker 默认；"
                "显式 coordinate=false 为阻塞路径）。",
            )
        draft = str(arguments.get("draft") or "").strip()
        if not draft:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="update_synthesis 需要非空的 draft。",
            )
        session.update_draft(draft)
        done = len(session.completed_run_ids)
        total = session.total_workers
        headline = f"合成草稿更新 · 已完成 {done}/{total}"
        self._sink.emit(
            team_synthesis_preview(
                execution_id=session.execution_id,
                completed=done,
                total=total,
                headline=headline,
                text=draft,
                workers=[],
                in_progress=True,
            )
        )
        # Persist coordination state into the turn journal for ask_user / resume.
        from agentcore.runtime.coordination.journal import record_coordination_snapshot

        record_coordination_snapshot(session)
        logger.info(
            "coordination.synthesis_updated",
            execution_id=session.execution_id,
            draft_chars=len(draft),
            completed=done,
            total=total,
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已更新合成草稿（{len(draft)} 字），用户可见「进展中」预览。",
        )


class CancelWorkerTool:
    """Cancel one in-flight worker during coordination (reuses cancel_run_ids)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="cancel_worker",
            description=(
                "【仅协调模式】终止某个仍在运行的 worker。"
                "追加新队员请用 replan(add=…)，不要另造原语。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "要终止的 worker run_id（见协调事件或团队进展）。",
                    },
                    "reason": {
                        "type": "string",
                        "description": "可选：终止原因（记入协调日志）。",
                    },
                },
                "required": ["run_id"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        session = active_coordination(context.execution_id)
        if session is None or not session.active:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="当前不在协调模式——仅在协调模式启动团队后可用（≥2 worker 默认；"
                "显式 coordinate=false 为阻塞路径）。",
            )
        run_id = str(arguments.get("run_id") or "").strip()
        if not run_id:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="cancel_worker 需要非空的 run_id。",
            )
        reason = str(arguments.get("reason") or "").strip()
        session.request_cancel(run_id)
        from agentcore.runtime.coordination.journal import record_coordination_snapshot

        record_coordination_snapshot(session)
        logger.info(
            "coordination.worker_cancel_requested",
            execution_id=session.execution_id,
            run_id=run_id,
            reason=reason[:120] if reason else "",
        )
        msg = f"已请求终止 worker {run_id}"
        if reason:
            msg += f"（原因：{reason}）"
        msg += "。调度器将在下一轮取消该任务。"
        return ToolResult(tool_call_id="", success=True, output=msg)


class ResolveEscalationTool:
    """CEO arbitration: settle a worker's blocking escalate parked for the CEO (D1)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="resolve_escalation",
            description=(
                "【仅协调模式】兑现队员的【阻塞升级】——把你的裁决回传给挂起的 worker，"
                "它经 escalate 恢复后继续。这是阻塞仲裁的【唯一兑现路径】。\n"
                "直裁：对技术/范围类问题直接给 answer。\n"
                "转交用户：偏好 / 授权 / 花钱类须先 ask_user 征询用户，拿到答复后再调本工具，"
                "并设 via_user=true（你是过滤器不是墙）。\n"
                "run_id 见阻塞仲裁事件中的 run_id。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "挂起等待仲裁的 worker run_id。",
                    },
                    "answer": {
                        "type": "string",
                        "description": "裁决正文（worker 将据此继续，优先于其暂定假设）。",
                    },
                    "via_user": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。true=本裁决经 ask_user 征询用户后作出"
                            "（偏好/授权/费用类必须如此）。"
                        ),
                    },
                },
                "required": ["run_id", "answer"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        session = active_coordination(context.execution_id)
        if session is None or not session.active:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="当前不在协调模式——仅在协调模式启动团队后可用（≥2 worker 默认；"
                "显式 coordinate=false 为阻塞路径）。",
            )
        run_id = str(arguments.get("run_id") or "").strip()
        answer = str(arguments.get("answer") or "").strip()
        via_user = bool(arguments.get("via_user"))
        if not run_id:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="resolve_escalation 需要非空的 run_id。",
            )
        if not answer:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="resolve_escalation 需要非空的 answer（你的裁决）。",
            )
        pending = session.get_arbitration(run_id)
        if pending is None:
            # Worker may already have been cancelled (ask_user soft-stop); stash for
            # the re-armed worker's next escalate(blocking=true).
            session.stash_resolution(run_id, answer=answer, via_user=via_user)
            from agentcore.runtime.coordination.journal import record_coordination_snapshot

            record_coordination_snapshot(session)
            logger.info(
                "coordination.escalation_stashed",
                execution_id=session.execution_id,
                run_id=run_id,
                via_user=via_user,
            )
            return ToolResult(
                tool_call_id="",
                success=True,
                output=(
                    f"已记录对 {run_id} 的裁决"
                    f"{'（经用户）' if via_user else ''}；"
                    "该队员恢复后将收到裁决并继续。"
                ),
            )
        escalation_id = str(pending.get("escalation_id") or "")
        conversation_id = str(pending.get("conversation_id") or context.conversation_id or "")
        registry = default_interaction_registry()
        settled = registry.resolve(
            escalation_id,
            {"answer": answer, "via_user": via_user},
            conversation_id=conversation_id,
        )
        if not settled:
            # Live Future gone — stash for re-armed pickup.
            session.stash_resolution(run_id, answer=answer, via_user=via_user)
            stashed = session.resolved_arbitrations.get(run_id)
            if stashed is not None and escalation_id:
                stashed["escalation_id"] = escalation_id
            from agentcore.runtime.coordination.journal import record_coordination_snapshot

            record_coordination_snapshot(session)
            logger.info(
                "coordination.escalation_stashed_after_miss",
                execution_id=session.execution_id,
                run_id=run_id,
                via_user=via_user,
            )
            return ToolResult(
                tool_call_id="",
                success=True,
                output=(
                    f"已记录对 {run_id} 的裁决"
                    f"{'（经用户）' if via_user else ''}；"
                    "挂起已解除或队员正重入，裁决将在其恢复时送达。"
                ),
            )
        session.clear_arbitration(run_id)
        from agentcore.runtime.coordination.journal import record_coordination_snapshot

        record_coordination_snapshot(session)
        logger.info(
            "coordination.escalation_resolved",
            execution_id=session.execution_id,
            run_id=run_id,
            via_user=via_user,
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=(
                f"已将裁决回传给 worker {run_id}"
                f"{'（经用户征询）' if via_user else ''}，队员将据此继续。"
            ),
        )
