"""Workspace storage, snapshots, retention, and local-op timeouts."""

from pydantic import BaseModel


class WorkspaceSettings(BaseModel):
    data_dir: str = "./data"

    storage_backend: str = "auto"
    s3_endpoint_url: str = ""
    s3_region: str = "cn-shenzhen"
    s3_bucket: str = "agentcore-workspaces"
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_addressing_style: str = "path"

    workspace_snapshot_enabled: bool = True
    workspace_auto_snapshot_max: int = 10

    workspace_retention_enabled: bool = True
    workspace_retention_days: int = 30
    workspace_retention_sweep_interval_seconds: int = 6 * 3600
    workspace_retention_batch_limit: int = 100

    workspace_upload_max_bytes: int = 25 * 1024 * 1024
    avatar_upload_max_bytes: int = 5 * 1024 * 1024
    workspace_clone_timeout_seconds: int = 120
    workspace_op_timeout_seconds: float = 60.0
    workspace_execute_timeout_slack_seconds: float = 30.0
    workspace_handoff_timeout_seconds: float = 300.0
    # AI 协作白板 (AI协作白板.md §六 M2): how long the BoardChannel waits for the bound
    # desktop to apply an op batch before failing the call (so a closed canvas / dropped
    # client never hangs the turn). Same class as the workspace-op deadline above.
    board_op_timeout_seconds: float = 60.0

    # Cloud (server-location) workers: code_execute runs in the API container subprocess
    # — not a real isolation boundary. Default off; local/sidecar keeps code_execute.
    code_execute_cloud_enabled: bool = False
    # Second, deliberate acknowledgement that the cloud subprocess "sandbox" is NOT a real
    # isolation boundary (no namespace/seccomp/rlimit/egress control): enabling cloud code
    # execution gives any authenticated user full-permission RCE inside the API container.
    # ``_validate_production_security`` refuses to boot a non-debug server that turns
    # ``code_execute_cloud_enabled`` on without ALSO setting this, so the dangerous config
    # can never be reached by flipping a single flag (SEC-005).
    code_execute_cloud_unsafe_ack: bool = False

    # Cloud (server-location) workers: use gVisor (runsc) for real isolation.
    # When true, code_execute is enabled on cloud workers without the unsafe-ack gate.
    gvisor_enabled: bool = False
    # Path to the runsc binary (default: on PATH).
    gvisor_runsc_path: str = "runsc"
    # runsc runtime state directory (containers, sandboxes).
    gvisor_runtime_root: str = "/tmp/agentcore-sandbox"

    # ── gVisor 灰度护栏（部署与运维.md §云端执行灰度 / 安全权限与治理.md §五）──
    # Global cap on concurrently RUNNING cloud sandbox executions per API process
    # (single-uvicorn production ⇒ effectively per host). Sized for the 2C8G box.
    gvisor_max_concurrent_executions: int = 2
    # Bounded grace queue: how long one call may wait for a free slot before it
    # fails fast with an explainable "busy" result. Budget check: slot wait (15)
    # + exec cap (60) stays under the engine EXECUTION backstop (90s).
    gvisor_slot_wait_seconds: float = 15.0
    # Per-execution hard resource caps enforced by the OCI spec. Authoritative for
    # cloud runs: an ExecutionRequest cannot exceed them. Memory default sized for
    # document/data workloads (pandas + matplotlib comfortably above 256MB).
    gvisor_memory_limit_mb: int = 512
    gvisor_timeout_max_seconds: int = 60
    # 产物写回 (copy-in/copy-out): the workspace is COPIED into a per-execution
    # staging dir (mounted rw at /workspace), and new/changed regular files are
    # copied back after the run. Caps bound both legs.
    gvisor_stage_max_bytes: int = 512 * 1024 * 1024
    gvisor_write_back_max_bytes: int = 128 * 1024 * 1024
    gvisor_write_back_max_files: int = 200
