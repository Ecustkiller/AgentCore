"""Shim — alias of `agentcore.runtime.closing_posture.cancel_zero` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import cancel_zero as _canonical

sys.modules[__name__] = _canonical
