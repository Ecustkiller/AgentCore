"""Shim — alias of `agentcore.runtime.closing_posture.browser` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.closing_posture import browser as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.closing_posture.browser import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
