"""Shim — alias of `agentcore.runtime.closing_posture.cancel_zero` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.closing_posture import cancel_zero as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.closing_posture.cancel_zero import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
