"""Shim — alias of `agentcore.runtime.turn.latency` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.turn import latency as _canonical

sys.modules[__name__] = _canonical
