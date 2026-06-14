"""TaskWorkspace: shared step outputs for a single multi-agent execution.

In-memory store of each step's output. Used for dependency injection (a step
reads upstream summaries) and final synthesis. Archived to the conversation on
completion (archival is out of scope for this MVP increment — kept in memory).
"""

from dataclasses import dataclass


@dataclass
class StepOutput:
    step_id: str
    agent_id: str
    role: str
    content: str
    summary: str
    duration_ms: int = 0


class TaskWorkspace:
    """Append-only store of step outputs keyed by step_id."""

    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        self._outputs: dict[str, StepOutput] = {}

    def write_output(self, output: StepOutput) -> None:
        self._outputs[output.step_id] = output

    def get_output(self, step_id: str) -> StepOutput | None:
        return self._outputs.get(step_id)

    def all_outputs(self) -> list[StepOutput]:
        return list(self._outputs.values())


def summarize(content: str, *, limit: int = 200) -> str:
    """Build a short summary for dependency injection and checkpoint review."""
    text = content.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"
