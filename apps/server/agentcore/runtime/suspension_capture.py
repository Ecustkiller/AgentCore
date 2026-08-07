"""Shim — alias of `agentcore.runtime.suspension.capture` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.suspension import capture as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.suspension.capture import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
