"""Shim — alias of `agentcore.runtime.closing_posture.b1` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import b1 as _canonical

sys.modules[__name__] = _canonical
