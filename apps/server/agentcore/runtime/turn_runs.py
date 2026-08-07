"""Shim — alias of `agentcore.runtime.turn.runs` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.turn import runs as _canonical

sys.modules[__name__] = _canonical
