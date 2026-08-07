"""Shim — alias of `agentcore.runtime.closing_posture.over_seat` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import over_seat as _canonical

sys.modules[__name__] = _canonical
