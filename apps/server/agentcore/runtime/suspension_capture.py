"""Shim — alias of `agentcore.runtime.suspension.capture` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.suspension import capture as _canonical

sys.modules[__name__] = _canonical
