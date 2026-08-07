"""Shim — alias of `agentcore.runtime.loop_controller.types` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.loop_controller import types as _canonical

sys.modules[__name__] = _canonical
