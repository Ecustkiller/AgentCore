"""drop workflow store + user_workflows

User canvas workflows, clock/webhook proxy runs, and the workflow store are
retired. Official named playbooks stay in runtime/runs/playbooks.

Revision ID: c1e7a9d4b2f6
Revises: f3c9a1e6b8d2
Create Date: 2026-09-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c1e7a9d4b2f6"
down_revision: str | None = "f3c9a1e6b8d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_workflow_store_reports_created", table_name="workflow_store_reports")
    op.drop_index("ix_workflow_store_reports_listing", table_name="workflow_store_reports")
    op.drop_table("workflow_store_reports")

    op.drop_index(
        "ix_workflow_store_installs_workflow", table_name="workflow_store_installs"
    )
    op.drop_index(
        "ix_workflow_store_installs_listing", table_name="workflow_store_installs"
    )
    op.drop_index("ix_workflow_store_installs_user", table_name="workflow_store_installs")
    op.drop_table("workflow_store_installs")

    op.drop_index("ix_workflow_store_versions_listing", table_name="workflow_store_versions")
    op.drop_table("workflow_store_versions")

    op.drop_index(
        "ix_workflow_store_listings_status_created",
        table_name="workflow_store_listings",
    )
    op.drop_index("ix_workflow_store_listings_author", table_name="workflow_store_listings")
    op.drop_table("workflow_store_listings")

    op.drop_index("ix_user_workflows_webhook_id", table_name="user_workflows")
    op.drop_index("ix_user_workflows_trigger_due", table_name="user_workflows")
    op.drop_index("ix_user_workflows_turn_source", table_name="user_workflows")
    op.drop_index("ix_user_workflows_user_created", table_name="user_workflows")
    op.drop_index(op.f("ix_user_workflows_user_id"), table_name="user_workflows")
    op.drop_table("user_workflows")


def downgrade() -> None:
    raise NotImplementedError("user workflows product is retired; no downgrade")
