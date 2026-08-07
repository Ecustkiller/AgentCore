"""Shim — alias of `agentcore.runtime.turn.token_budget` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.turn import token_budget as _canonical

sys.modules[__name__] = _canonical
