"""Per-surface declaration rosters.

Authoritative global order = ``builtin`` + ``worker_only`` + ``ceo_orchestration``
(concat of each ``load_roster()``). Append new tools to the matching surface
module — do not re-order across surfaces.
"""

from __future__ import annotations


def load_all_declared_tools() -> tuple[type, ...]:
    """Concatenate surface rosters in public order."""
    from agentcore.tools.registration.rosters.builtin import load_roster as load_builtin
    from agentcore.tools.registration.rosters.ceo_orchestration import (
        load_roster as load_ceo,
    )
    from agentcore.tools.registration.rosters.worker_only import (
        load_roster as load_worker,
    )

    return load_builtin() + load_worker() + load_ceo()
