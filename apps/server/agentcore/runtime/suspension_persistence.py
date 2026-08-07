"""Shim — alias of `agentcore.runtime.suspension.persistence` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.suspension import persistence as _canonical

sys.modules[__name__] = _canonical
