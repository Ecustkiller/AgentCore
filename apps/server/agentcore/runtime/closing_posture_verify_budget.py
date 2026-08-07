"""Shim — alias of `agentcore.runtime.closing_posture.verify_budget` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import verify_budget as _canonical

sys.modules[__name__] = _canonical
