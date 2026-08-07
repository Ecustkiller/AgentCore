"""Shim — alias of `agentcore.runtime.closing_posture.resume` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import resume as _canonical

sys.modules[__name__] = _canonical
