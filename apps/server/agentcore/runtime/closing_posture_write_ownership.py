"""Shim — alias of `agentcore.runtime.closing_posture.write_ownership` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import write_ownership as _canonical

sys.modules[__name__] = _canonical
