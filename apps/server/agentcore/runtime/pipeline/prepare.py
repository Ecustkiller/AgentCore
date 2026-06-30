"""Shim — implementation moved to ``runtime.resolve.prepare``.

Kept as a back-compat re-export so existing importers (``pipeline.__init__``,
``pipeline.run``) keep working. ``__all__`` marks the names as re-exported so
``ruff --fix`` does not strip them as unused.
"""

from agentcore.runtime.resolve.prepare import (
    _assemble_ceo_toolset,
    _build_attachment_context,
)

__all__ = ["_assemble_ceo_toolset", "_build_attachment_context"]

