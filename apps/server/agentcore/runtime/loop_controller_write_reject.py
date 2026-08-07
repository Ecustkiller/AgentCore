"""Shim — alias of `agentcore.runtime.loop_controller.write_reject` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.loop_controller import write_reject as _canonical

sys.modules[__name__] = _canonical
