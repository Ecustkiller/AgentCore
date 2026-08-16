"""Pin the postgres client-key permission fix (startup /readyz PermissionError).

asyncpg defaults to ssl=prefer and loads ~/.postgresql/postgresql.key via
Path.home(). Sandbox overlay starts as root (HOME=/root); after setpriv the
process is uid app. A 0600 root-owned key then raises PermissionError and
/readyz reports the database down. The key must be readable by app and not
world-readable (0644 is rejected by OpenSSL/libpq).
"""

from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
_DOCKERFILE = _REPO / "apps" / "server" / "Dockerfile"
_ENTRYPOINT = _REPO / "deploy" / "api-sandbox-entrypoint.sh"


def test_dockerfile_creates_app_home_and_sets_home_env():
    text = _DOCKERFILE.read_text(encoding="utf-8")
    assert "--no-create-home" not in text
    assert "--create-home --home-dir /home/app" in text
    assert "HOME=/home/app" in text
    assert "chmod 0700 /home/app" in text


def test_entrypoint_relocates_root_postgresql_certs_with_safe_modes():
    text = _ENTRYPOINT.read_text(encoding="utf-8")
    assert "export HOME=/home/app" in text
    assert "/root/.postgresql" in text
    assert "/home/app/.postgresql" in text
    assert "chmod 0600" in text
    assert "chmod 0700 /home/app/.postgresql" in text
    assert "chmod 0700 /root" in text
    assert "chown -R app:app /home/app/.postgresql" in text
