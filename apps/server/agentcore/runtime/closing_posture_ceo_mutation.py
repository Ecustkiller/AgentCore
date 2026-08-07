"""Shim — alias of `agentcore.runtime.closing_posture.ceo_mutation` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import ceo_mutation as _canonical

sys.modules[__name__] = _canonical
