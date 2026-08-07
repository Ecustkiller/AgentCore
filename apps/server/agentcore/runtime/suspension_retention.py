"""Shim — alias of `agentcore.runtime.suspension.retention` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.suspension import retention as _canonical

sys.modules[__name__] = _canonical
