"""Shim — alias of `agentcore.runtime.turn.interrupt` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.turn import interrupt as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.turn.interrupt import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
