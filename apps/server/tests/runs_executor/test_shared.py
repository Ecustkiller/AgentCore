from agentcore.runtime.runs.executor_shared import _is_hard_failure
from agentcore.runtime.runs.types import Deliverable


def test_is_hard_failure_empty_always_hard():
    assert _is_hard_failure("   ", None) is True
    assert _is_hard_failure("", Deliverable(strict=False)) is True


def test_is_hard_failure_nonempty_depends_on_strict():
    assert _is_hard_failure("x", None) is False
    assert _is_hard_failure("x", Deliverable(strict=False)) is False
    assert _is_hard_failure("x", Deliverable(strict=True)) is True
