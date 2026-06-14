"""Run-output text helpers.

``summarize`` trims a worker's product for injection into a downstream
dependent's prompt and for the ``run_completed`` event's output summary. (The
legacy ``TaskWorkspace`` / ``StepOutput`` store retired with ``run_multi_agent``;
the unified Run model passes products via ``RunState.content`` instead — see
runs/executor.py.)
"""


def summarize(content: str, *, limit: int = 200) -> str:
    """Build a short summary for dependency injection and run-completed events."""
    text = content.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"
