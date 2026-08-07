"""Shim — alias of `agentcore.runtime.closing_posture.hollow` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import hollow as _canonical

sys.modules[__name__] = _canonical
