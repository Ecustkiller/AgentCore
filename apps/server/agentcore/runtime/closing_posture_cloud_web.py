"""Shim — alias of `agentcore.runtime.closing_posture.cloud_web` (P3-A import freeze)."""
from __future__ import annotations

import sys

from agentcore.runtime.closing_posture import cloud_web as _canonical

sys.modules[__name__] = _canonical
