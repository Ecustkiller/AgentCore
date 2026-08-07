"""Shim — alias of `agentcore.runtime.closing_posture.empty_handoff` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import empty_handoff as _canonical

sys.modules[__name__] = _canonical
