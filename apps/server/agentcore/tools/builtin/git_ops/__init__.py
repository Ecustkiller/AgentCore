"""Git helpers that are not a model tool.

``spawn.cloud_git_auth_env`` injects the account PAT into cloud ``run``.
``binary_health`` answers whether this process can exec ``git``, which the
workspace fact line uses. User SCM stays on ``workspace.git`` and the
``git_repo_status`` / ``git_scm`` channel ops.
"""
