"""Shim — alias of `agentcore.runtime.turn.paused_capture` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.turn import paused_capture as _canonical

sys.modules[__name__] = _canonical
