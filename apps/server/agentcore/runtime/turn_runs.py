"""Shim — alias of `agentcore.runtime.turn.runs` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.turn import runs as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.turn.runs import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
