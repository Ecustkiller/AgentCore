"""User-level billing preference helpers.

NOTE: the gate is intentionally NOT re-exported here. ``billing.gate`` imports
``conversation.quota`` → ``db.repositories`` → ``billing.preference``; pulling
the gate into this package ``__init__`` would close that chain into a circular
import whenever ``conversation.quota`` is imported first (e.g. tests importing
it directly). Import ``preflight_llm_credentials`` from ``agentcore.billing.gate``.
"""

from agentcore.billing.preference import (
    BillingMode,
    default_billing_preference,
    is_platform_available,
    resolve_effective_billing_mode,
)

__all__ = [
    "BillingMode",
    "default_billing_preference",
    "is_platform_available",
    "resolve_effective_billing_mode",
]
