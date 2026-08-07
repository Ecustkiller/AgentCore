"""Shim — alias of `agentcore.runtime.suspension.retention` (P3-A import freeze)."""
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from agentcore.runtime.suspension import retention as _canonical

if TYPE_CHECKING:
    from agentcore.runtime.suspension.retention import *  # noqa: F403
else:
    sys.modules[__name__] = _canonical
