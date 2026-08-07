"""Shim — alias of `agentcore.runtime.closing_posture.write_ownership` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.closing_posture import write_ownership as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.closing_posture.write_ownership import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
