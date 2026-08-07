"""Shim — alias of `agentcore.runtime.turn.latency` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.turn import latency as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.turn.latency import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
