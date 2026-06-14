"""Orchestrator planner: classify the request and emit a collaboration plan.

Calls the orchestrator (fast) model to produce a structured JSON plan, then
parses it tolerantly. Any failure falls back to a safe single-agent plan, so the
user always gets at least a normal chat experience (编排器Prompt与输出结构.md §七).
"""

from agentcore.core.logging import get_logger
from agentcore.llm.config import build_request, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage
from agentcore.runtime.plan import OrchestratorPlan, parse_plan, single_agent_plan

logger = get_logger(__name__)

_HISTORY_MAX_MESSAGES = 6
_HISTORY_MSG_MAX_CHARS = 200

_PLANNER_SYSTEM_PROMPT = """\
你是 AgentCore 的任务编排器。根据用户请求，输出一份驱动执行引擎的结构化协作计划。

你必须只输出一个 JSON 对象，不要有任何额外文字、解释或 markdown 代码块。JSON 结构如下：

{
  "plan_type": "single_agent | multi_agent",
  "task_summary": "一句话任务摘要（展示给用户）",
  "agents": [
    {
      "id": "agent_1",
      "role": "角色名称（展示给用户，如 架构师/研究员/审阅者）",
      "objective": "该 Agent 的目标",
      "system_prompt_supplement": "补充角色指令，可为 null",
      "tools": ["仅可从可用工具列表中选取的工具名"],
      "model_preference": "fast | strong",
      "thinking": "可选，仅极复杂子任务需要时填 true；省略则用档位默认",
      "reasoning_effort": "可选，仅极复杂子任务填 \"max\"；省略则用档位默认"
    }
  ],
  "steps": [
    {
      "id": "step_1",
      "agent_id": "执行该步骤的 agent id",
      "task": "该步骤的具体任务（作为该 Agent 的用户指令）",
      "depends_on": ["依赖的步骤 id 列表，无依赖则为空数组"],
      "expected_output": "预期产出描述"
    }
  ],
  "checkpoints": [
    {
      "after_step": "在哪个步骤后暂停让用户确认",
      "reason": "为什么需要确认（展示给用户）",
      "review_focus": "确认时关注什么"
    }
  ],
  "output_strategy": { "merge_type": "direct | sequential | merge | compare", "final_summary": true }
}

决策规则（务必遵守）：
- 强烈偏向 single_agent。绝大多数请求——问答、闲聊、解释、单文件改写、单点搜索——都用 single_agent（1 个 agent、1 个 step、depends_on 为空）。
- 仅当任务确实需要"分工协作"才用 multi_agent：需要多视角并行、明显的多阶段流水线（设计→实现→测试）、或对比/辩论。
- depends_on 决定串行与并行：无依赖的步骤会并行执行；有依赖的步骤等待前置完成。
- 最多 5 个 agent、最多 20 个 step。不要过度拆分。
- tools 只能从"可用工具"列表里选；agent 不需要工具就给空数组。
- model_preference 只有两档：较简单、范围明确的步骤（取数、格式化、单点查询、简单改写）用 fast（轻量推理、回合预算小）；需要更深推理、复杂判断、或对质量有要求的步骤用 strong（深度推理、可按需升 max）；拿不准就用 strong。
- thinking / reasoning_effort 是可选的"按需升档"旋钮，绝大多数情况省略（用档位默认）。仅当某个 agent 的子任务确实极复杂、需要最强推理时，才显式声明 reasoning_effort="max"（隐含 thinking=true）。它只能升档（提到 max），不能降档——要省就直接选 fast。
- checkpoints 克制使用：只在"后续强依赖前序、且方向可能有歧义"的关键决策点设置；简单任务不要设。

反例：不要为"今天天气如何""解释一下 JWT"这类请求创建多个 agent。"""


def _summarize_history(history: list[dict]) -> str:
    if not history:
        return "（无历史）"
    recent = history[-_HISTORY_MAX_MESSAGES:]
    lines = []
    for msg in recent:
        content = (msg.get("content") or "").strip().replace("\n", " ")
        if len(content) > _HISTORY_MSG_MAX_CHARS:
            content = content[:_HISTORY_MSG_MAX_CHARS] + "…"
        lines.append(f"{msg.get('role', 'user')}: {content}")
    return "\n".join(lines)


def _build_messages(
    user_message: str, history: list[dict], available_tools: list[dict]
) -> list[LLMMessage]:
    tools_desc = (
        "\n".join(
            f"- {t['name']}（{t.get('category', '')}）: {t.get('description', '')}"
            for t in available_tools
        )
        or "（无）"
    )
    user_content = (
        f"## 用户请求\n{user_message}\n\n"
        f"## 最近对话\n{_summarize_history(history)}\n\n"
        f"## 可用工具\n{tools_desc}\n\n"
        "## 约束\n最多 5 个 agent，最多 10 个并行步骤。\n\n"
        "现在输出协作计划 JSON。"
    )
    return [
        LLMMessage(role="system", content=_PLANNER_SYSTEM_PROMPT),
        LLMMessage(role="user", content=user_content),
    ]


async def make_plan(
    *,
    llm: DeepSeekProvider,
    user_message: str,
    history: list[dict],
    available_tools: list[dict],
) -> OrchestratorPlan:
    """Produce a collaboration plan, falling back to single-agent on any failure."""
    tool_names = [t["name"] for t in available_tools]
    profile = get_profile("orchestrator")

    try:
        response = await llm.complete(
            build_request(
                profile,
                _build_messages(user_message, history, available_tools),
                tool_choice="none",
                stream=False,
            )
        )
        plan = parse_plan(
            response.content,
            fallback_summary=user_message,
            available_tools=tool_names,
        )
        logger.info(
            "plan_made",
            plan_type=plan.plan_type,
            agents=len(plan.agents),
            steps=len(plan.steps),
            checkpoints=len(plan.checkpoints),
        )
        return plan
    except Exception as e:
        logger.error("planner_failed", error=str(e), exc_info=True)
        return single_agent_plan(user_message, tool_names)
