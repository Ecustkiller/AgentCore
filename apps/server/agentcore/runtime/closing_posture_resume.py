"""Shim — alias of `agentcore.runtime.closing_posture.resume` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.closing_posture import resume as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.closing_posture.resume import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
