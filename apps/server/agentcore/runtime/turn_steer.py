"""Shim — alias of `agentcore.runtime.turn.steer` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.turn import steer as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.turn.steer import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
