"""Tests for declared latent workspace dirs (list-before-create)."""

from agentcore.workspace.attachments import ATTACHMENTS_DIR
from agentcore.workspace.declared_dirs import is_declared_latent_dir
from agentcore.workspace.stage_dirs import AGENTCORE_ROOT


def test_declared_latent_covers_workroom_root_and_attachments():
    assert is_declared_latent_dir(AGENTCORE_ROOT)
    assert is_declared_latent_dir(ATTACHMENTS_DIR)
    assert is_declared_latent_dir(f"{ATTACHMENTS_DIR}/a.pdf")


def test_declared_latent_rejects_guesses_and_leftover_docs_tree():
    assert not is_declared_latent_dir(".")
    assert not is_declared_latent_dir("")
    assert not is_declared_latent_dir("apps/server/src")
    assert not is_declared_latent_dir("src")
    assert not is_declared_latent_dir("AgentCore/not-a-stage")
    assert not is_declared_latent_dir("AgentCore/文档")
    assert not is_declared_latent_dir("AgentCore/文档/research")
    assert not is_declared_latent_dir("AgentCore/文档/工作稿")
    assert not is_declared_latent_dir("AgentCore/文档/research/笔记.md")
