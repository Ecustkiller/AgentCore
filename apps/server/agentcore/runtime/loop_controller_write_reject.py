"""Shim — alias of `agentcore.runtime.loop_controller.write_reject` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.loop_controller import write_reject as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.loop_controller.write_reject import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
