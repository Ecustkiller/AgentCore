"""deploy-paths.sh is the single source for live-stack compose/env resolution."""

from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[3] / "deploy" / "scripts"


def test_three_scripts_source_shared_deploy_paths():
    for name in ("backup.sh", "restore.sh", "deploy-server.sh"):
        text = (_SCRIPTS / name).read_text(encoding="utf-8")
        assert "deploy-paths.sh" in text
        assert b"\r\n" not in (_SCRIPTS / name).read_bytes()
    assert (_SCRIPTS / "deploy-paths.sh").is_file()
    assert b"\r\n" not in (_SCRIPTS / "deploy-paths.sh").read_bytes()


def test_restore_uses_deploy_dir_for_compose_files():
    text = (_SCRIPTS / "restore.sh").read_text(encoding="utf-8")
    assert '-f "$DEPLOY_DIR/docker-compose.server.yml"' in text
    assert '-f "$DEPLOY_DIR/docker-compose.app.yml"' in text
    assert '-f "$REPO_DIR/deploy/docker-compose.server.yml"' not in text


def test_deploy_server_keeps_repo_dir_compose_files():
    """Path snippet may fix ENV_FILE; compose file selection must stay $REPO_DIR/deploy."""
    text = (_SCRIPTS / "deploy-server.sh").read_text(encoding="utf-8")
    assert '-f "$REPO_DIR/deploy/docker-compose.server.yml"' in text
    assert '-f "$REPO_DIR/deploy/docker-compose.app.yml"' in text
    assert '_sandbox_yml="$REPO_DIR/deploy/docker-compose.sandbox.yml"' in text


def test_deploy_paths_resolves_from_home_env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text(
        "AGENTCORE_DEPLOY_DIR=/opt/agentcore/repo/deploy_f6d1637\n",
        encoding="utf-8",
        newline="\n",
    )
    script = tmp_path / "print.sh"
    snippet = _SCRIPTS / "deploy-paths.sh"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'AGENTCORE_HOME="{home.as_posix()}"\n'
        f'. "{snippet.as_posix()}"\n'
        'printf "DEPLOY_DIR=%s\\n" "$DEPLOY_DIR"\n'
        'printf "ENV_FILE=%s\\n" "$ENV_FILE"\n'
        'printf "REPO_DIR=%s\\n" "$REPO_DIR"\n',
        encoding="utf-8",
        newline="\n",
    )
    import shutil
    import subprocess
    import sys

    bash = None
    if sys.platform == "win32":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        if candidate.is_file():
            bash = str(candidate)
    else:
        bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash not available")
    out = subprocess.check_output([bash, str(script)], text=True)
    assert "DEPLOY_DIR=/opt/agentcore/repo/deploy_f6d1637" in out
    assert "ENV_FILE=/opt/agentcore/repo/deploy_f6d1637/config/production.env" in out
    assert f"REPO_DIR={home.as_posix()}/repo" in out


def test_deploy_paths_keeps_preset_env_file(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text(
        "AGENTCORE_DEPLOY_DIR=/opt/agentcore/repo/deploy_f6d1637\n",
        encoding="utf-8",
        newline="\n",
    )
    script = tmp_path / "print.sh"
    snippet = _SCRIPTS / "deploy-paths.sh"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'AGENTCORE_HOME="{home.as_posix()}"\n'
        "ENV_FILE=/already/set/production.env\n"
        f'. "{snippet.as_posix()}"\n'
        'printf "ENV_FILE=%s\\n" "$ENV_FILE"\n'
        'printf "DEPLOY_DIR=%s\\n" "$DEPLOY_DIR"\n',
        encoding="utf-8",
        newline="\n",
    )
    import shutil
    import subprocess
    import sys

    bash = None
    if sys.platform == "win32":
        candidate = Path(r"C:\Program Files\Git\bin\bash.exe")
        if candidate.is_file():
            bash = str(candidate)
    else:
        bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash not available")
    out = subprocess.check_output([bash, str(script)], text=True)
    assert "ENV_FILE=/already/set/production.env" in out
    assert "DEPLOY_DIR=/opt/agentcore/repo/deploy_f6d1637" in out
