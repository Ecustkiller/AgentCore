"""Tests for declared latent workspace dirs (list-before-create)."""

from agentcore.workspace.attachments import ATTACHMENTS_DIR
from agentcore.workspace.declared_dirs import is_declared_latent_dir
from agentcore.workspace.stage_dirs import (
    AGENTCORE_ROOT,
    DOCS_PREFIX,
    RESEARCH_DIR,
    RESEARCH_PREFIX,
)


def test_declared_latent_covers_stage_tree_and_attachments():
    assert is_declared_latent_dir(AGENTCORE_ROOT)
    assert is_declared_latent_dir(DOCS_PREFIX)
    assert is_declared_latent_dir(RESEARCH_DIR)
    assert is_declared_latent_dir(f"{RESEARCH_PREFIX}笔记.md")
    assert is_declared_latent_dir(ATTACHMENTS_DIR)
    assert is_declared_latent_dir(f"{ATTACHMENTS_DIR}/a.pdf")


def test_declared_latent_rejects_guesses():
    assert not is_declared_latent_dir(".")
    assert not is_declared_latent_dir("")
    assert not is_declared_latent_dir("apps/server/src")
    assert not is_declared_latent_dir("src")
    assert not is_declared_latent_dir("AgentCore/not-a-stage")
    assert not is_declared_latent_dir(f"{DOCS_PREFIX}/random")
