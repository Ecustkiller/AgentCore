"""Shim — alias of `agentcore.runtime.loop_controller.circuit` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.loop_controller import circuit as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.loop_controller.circuit import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
